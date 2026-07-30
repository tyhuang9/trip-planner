package com.trip.service.realtime;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.CopyOnWriteArrayList;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.trip.config.AppProperties;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;

/**
 * In-memory SSE fan-out keyed by internal trip id. Heartbeats make dead
 * transports fail promptly, while client identities let an intentional
 * reconnect replace its predecessor before capacity is checked.
 */
@Service
public class TripEventBroker {

    private static final Logger log = LoggerFactory.getLogger(TripEventBroker.class);

    static final int MAX_SUBSCRIBERS_PER_ACTOR_TRIP = 2;
    static final int MAX_SUBSCRIBERS_PER_IP = 32;
    static final int MAX_SUBSCRIBERS_PER_TRIP = 64;
    static final int MAX_GLOBAL_SUBSCRIBERS = 256;

    private final ConcurrentMap<Long, CopyOnWriteArrayList<Subscription>> subscriptionsByTrip =
        new ConcurrentHashMap<>();
    private final Duration staleAfter;
    private final Duration maxLifetime;
    private final Clock clock;
    private final Counter staleCounter;
    private final Counter expiredCounter;
    private final Counter heartbeatCounter;
    private final Counter sameClientReplacementCounter;
    private final Counter staleCapacityReplacementCounter;
    private final Map<LimitScope, Counter> rejectedCounters;
    private int globalSubscriberCount;

    @Autowired
    public TripEventBroker(AppProperties appProperties, MeterRegistry meterRegistry) {
        this(appProperties, meterRegistry, Clock.systemUTC());
    }

    TripEventBroker(AppProperties appProperties, MeterRegistry meterRegistry, Clock clock) {
        AppProperties.Realtime realtime = appProperties.getRealtime();
        Duration heartbeatInterval = requirePositive(
            realtime.getHeartbeatInterval(), "heartbeat-interval");
        this.staleAfter = requirePositive(realtime.getStaleAfter(), "stale-after");
        this.maxLifetime = requirePositive(realtime.getMaxLifetime(), "max-lifetime");
        if (staleAfter.compareTo(heartbeatInterval.multipliedBy(2)) < 0) {
            throw new IllegalArgumentException(
                "app.realtime.stale-after must allow at least two heartbeat intervals");
        }
        if (maxLifetime.compareTo(staleAfter) <= 0) {
            throw new IllegalArgumentException(
                "app.realtime.max-lifetime must be greater than stale-after");
        }
        this.clock = clock;
        this.staleCounter = meterRegistry.counter("dupert.sse.subscriptions.stale");
        this.expiredCounter = meterRegistry.counter("dupert.sse.subscriptions.expired");
        this.heartbeatCounter = meterRegistry.counter("dupert.sse.heartbeats.sent");
        this.sameClientReplacementCounter = meterRegistry.counter(
            "dupert.sse.subscriptions.replaced", "reason", "same_client");
        this.staleCapacityReplacementCounter = meterRegistry.counter(
            "dupert.sse.subscriptions.replaced", "reason", "stale_capacity");
        this.rejectedCounters = Map.of(
            LimitScope.GLOBAL, rejectedCounter(meterRegistry, LimitScope.GLOBAL),
            LimitScope.TRIP, rejectedCounter(meterRegistry, LimitScope.TRIP),
            LimitScope.CLIENT_IP, rejectedCounter(meterRegistry, LimitScope.CLIENT_IP),
            LimitScope.ACTOR_TRIP, rejectedCounter(meterRegistry, LimitScope.ACTOR_TRIP));
        Gauge.builder("dupert.sse.subscriptions.active", this, TripEventBroker::activeCount)
            .description("Active trip SSE subscriptions in this application instance")
            .register(meterRegistry);
    }

    public SseEmitter subscribe(Long tripId, String actorKey, String clientIp) {
        return subscribe(tripId, actorKey, clientIp, null);
    }

    public SseEmitter subscribe(Long tripId, String actorKey, String clientIp, String streamClientId) {
        String normalizedActorKey = normalizeRequiredKey(actorKey);
        String normalizedClientIp = normalizeRequiredKey(clientIp);
        String normalizedStreamClientId = normalizeOptionalKey(streamClientId);
        Instant now = clock.instant();
        SseEmitter emitter = new SseEmitter(maxLifetime.toMillis());
        Subscription subscription = new Subscription(
            emitter,
            normalizedActorKey,
            normalizedClientIp,
            normalizedStreamClientId,
            now);
        Replacement replacement;

        synchronized (this) {
            CopyOnWriteArrayList<Subscription> subscriptions = subscriptionsByTrip.get(tripId);
            if (subscriptions == null) {
                subscriptions = new CopyOnWriteArrayList<>();
            }
            replacement = findReplacement(subscriptions, subscription, now);
            assertCapacity(
                subscriptions,
                normalizedActorKey,
                normalizedClientIp,
                replacement == null ? null : replacement.subscription());
            if (replacement != null) {
                removeLocked(tripId, replacement.subscription());
            }
            subscriptions.add(subscription);
            subscriptionsByTrip.putIfAbsent(tripId, subscriptions);
            globalSubscriberCount++;
        }

        Runnable cleanup = () -> remove(tripId, subscription);
        emitter.onCompletion(cleanup);
        emitter.onTimeout(cleanup);
        emitter.onError(_error -> cleanup.run());

        if (replacement != null) {
            recordReplacement(replacement);
            replacement.subscription().emitter().complete();
        }

        try {
            emitter.send(SseEmitter.event()
                .name("connected")
                .data(Map.of("type", "connected")));
            subscription.markWriteSucceeded(clock.instant());
        } catch (IOException | IllegalStateException ex) {
            remove(tripId, subscription);
            emitter.completeWithError(ex);
        }

        return emitter;
    }

    public void publish(Long tripId, TripEvent event) {
        CopyOnWriteArrayList<Subscription> subscriptions = subscriptionsByTrip.get(tripId);
        if (subscriptions == null || subscriptions.isEmpty()) {
            return;
        }

        for (Subscription subscription : subscriptions) {
            try {
                subscription.emitter().send(SseEmitter.event()
                    .name("trip-event")
                    .data(event));
                subscription.markWriteSucceeded(clock.instant());
            } catch (IOException | IllegalStateException ex) {
                removeFailedSubscription(tripId, subscription, ex);
            }
        }
    }

    /**
     * Heartbeats run every configured interval. A failed write is removed
     * immediately; a connection with no successful write is removed after
     * {@code stale-after}; every connection is renewed by {@code max-lifetime}.
     */
    @Scheduled(fixedDelayString = "${app.realtime.heartbeat-interval:15s}")
    void maintainSubscriptions() {
        maintainSubscriptions(clock.instant());
    }

    void maintainSubscriptions(Instant now) {
        for (Map.Entry<Long, CopyOnWriteArrayList<Subscription>> entry : subscriptionsByTrip.entrySet()) {
            Long tripId = entry.getKey();
            for (Subscription subscription : entry.getValue()) {
                if (ageAtLeast(subscription.createdAt(), now, maxLifetime)) {
                    if (remove(tripId, subscription)) {
                        expiredCounter.increment();
                        log.info("Expired realtime subscription at configured maximum lifetime (active={})",
                            activeCount());
                        subscription.emitter().complete();
                    }
                    continue;
                }
                if (isStale(subscription, now)) {
                    if (remove(tripId, subscription)) {
                        staleCounter.increment();
                        log.warn("Removed stale realtime subscription (active={})", activeCount());
                        subscription.emitter().complete();
                    }
                    continue;
                }
                try {
                    subscription.emitter().send(SseEmitter.event().comment("keepalive"));
                    subscription.markWriteSucceeded(now);
                    heartbeatCounter.increment();
                } catch (IOException | IllegalStateException ex) {
                    removeFailedSubscription(tripId, subscription, ex);
                }
            }
        }
    }

    public void disconnect(Long tripId) {
        List<Subscription> subscriptions;
        synchronized (this) {
            subscriptions = subscriptionsByTrip.remove(tripId);
            if (subscriptions == null || subscriptions.isEmpty()) {
                return;
            }
            globalSubscriberCount = Math.max(0, globalSubscriberCount - subscriptions.size());
        }
        for (Subscription subscription : subscriptions) {
            subscription.emitter().complete();
        }
    }

    int subscriberCountForTest(Long tripId) {
        return subscriptionsByTrip.getOrDefault(tripId, new CopyOnWriteArrayList<>()).size();
    }

    int globalSubscriberCountForTest() {
        return activeCount();
    }

    Instant lastSuccessfulWriteForTest(Long tripId) {
        return subscriptionsByTrip.getOrDefault(tripId, new CopyOnWriteArrayList<>()).stream()
            .map(Subscription::lastSuccessfulWriteAt)
            .max(Comparator.naturalOrder())
            .orElse(null);
    }

    private Replacement findReplacement(List<Subscription> subscriptions,
                                        Subscription candidate,
                                        Instant now) {
        if (candidate.streamClientId() != null) {
            Subscription sameClient = subscriptions.stream()
                .filter(existing -> existing.actorKey().equals(candidate.actorKey()))
                .filter(existing -> candidate.streamClientId().equals(existing.streamClientId()))
                .min(Comparator.comparing(Subscription::createdAt))
                .orElse(null);
            if (sameClient != null) {
                return new Replacement(sameClient, ReplacementReason.SAME_CLIENT);
            }
        }

        if (countByActor(subscriptions, candidate.actorKey()) < MAX_SUBSCRIBERS_PER_ACTOR_TRIP) {
            return null;
        }
        return subscriptions.stream()
            .filter(existing -> existing.actorKey().equals(candidate.actorKey()))
            .filter(existing -> isStale(existing, now))
            .min(Comparator.comparing(Subscription::createdAt))
            .map(existing -> new Replacement(existing, ReplacementReason.STALE_CAPACITY))
            .orElse(null);
    }

    private void assertCapacity(List<Subscription> subscriptions,
                                String actorKey,
                                String clientIp,
                                Subscription replacement) {
        int replacementCount = replacement == null ? 0 : 1;
        int replacementIpCount = replacement != null && replacement.clientIp().equals(clientIp) ? 1 : 0;
        int replacementActorCount = replacement != null && replacement.actorKey().equals(actorKey) ? 1 : 0;
        LimitScope scope = null;
        if (globalSubscriberCount - replacementCount >= MAX_GLOBAL_SUBSCRIBERS) {
            scope = LimitScope.GLOBAL;
        } else if (subscriptions.size() - replacementCount >= MAX_SUBSCRIBERS_PER_TRIP) {
            scope = LimitScope.TRIP;
        } else if (countByClientIp(clientIp) - replacementIpCount >= MAX_SUBSCRIBERS_PER_IP) {
            scope = LimitScope.CLIENT_IP;
        } else if (countByActor(subscriptions, actorKey) - replacementActorCount
                >= MAX_SUBSCRIBERS_PER_ACTOR_TRIP) {
            scope = LimitScope.ACTOR_TRIP;
        }
        if (scope != null) {
            rejectedCounters.get(scope).increment();
            log.warn("Rejected realtime subscription at {} capacity (active={})",
                scope.metricValue(), globalSubscriberCount);
            throw new StreamLimitExceededException();
        }
    }

    private static long countByActor(List<Subscription> subscriptions, String actorKey) {
        return subscriptions.stream()
            .filter(subscription -> subscription.actorKey().equals(actorKey))
            .count();
    }

    private long countByClientIp(String clientIp) {
        return subscriptionsByTrip.values().stream()
            .flatMap(List::stream)
            .filter(subscription -> subscription.clientIp().equals(clientIp))
            .count();
    }

    private boolean remove(Long tripId, Subscription subscription) {
        synchronized (this) {
            return removeLocked(tripId, subscription);
        }
    }

    private boolean removeLocked(Long tripId, Subscription subscription) {
        CopyOnWriteArrayList<Subscription> subscriptions = subscriptionsByTrip.get(tripId);
        if (subscriptions == null || !subscriptions.remove(subscription)) {
            return false;
        }
        globalSubscriberCount = Math.max(0, globalSubscriberCount - 1);
        if (subscriptions.isEmpty()) {
            subscriptionsByTrip.remove(tripId, subscriptions);
        }
        return true;
    }

    private void removeFailedSubscription(Long tripId, Subscription subscription, Exception ex) {
        if (remove(tripId, subscription)) {
            staleCounter.increment();
            log.warn("Removed realtime subscription after failed write (active={})", activeCount());
        }
        subscription.emitter().completeWithError(ex);
    }

    private void recordReplacement(Replacement replacement) {
        if (replacement.reason() == ReplacementReason.SAME_CLIENT) {
            sameClientReplacementCounter.increment();
        } else {
            staleCapacityReplacementCounter.increment();
        }
        log.info("Replaced realtime subscription (reason={}, active={})",
            replacement.reason().metricValue(), activeCount());
    }

    private synchronized int activeCount() {
        return globalSubscriberCount;
    }

    private boolean isStale(Subscription subscription, Instant now) {
        return ageAtLeast(subscription.lastSuccessfulWriteAt(), now, staleAfter);
    }

    private static boolean ageAtLeast(Instant start, Instant now, Duration threshold) {
        return !now.isBefore(start.plus(threshold));
    }

    private static Duration requirePositive(Duration duration, String property) {
        if (duration == null || duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException("app.realtime." + property + " must be positive");
        }
        return duration;
    }

    private static String normalizeRequiredKey(String key) {
        if (key == null || key.isBlank()) {
            return "unknown";
        }
        return key;
    }

    private static String normalizeOptionalKey(String key) {
        return key == null || key.isBlank() ? null : key;
    }

    private static Counter rejectedCounter(MeterRegistry meterRegistry, LimitScope scope) {
        return meterRegistry.counter(
            "dupert.sse.subscriptions.rejected", "scope", scope.metricValue());
    }

    private static final class Subscription {
        private final SseEmitter emitter;
        private final String actorKey;
        private final String clientIp;
        private final String streamClientId;
        private final Instant createdAt;
        private volatile Instant lastSuccessfulWriteAt;

        private Subscription(SseEmitter emitter,
                             String actorKey,
                             String clientIp,
                             String streamClientId,
                             Instant createdAt) {
            this.emitter = emitter;
            this.actorKey = actorKey;
            this.clientIp = clientIp;
            this.streamClientId = streamClientId;
            this.createdAt = createdAt;
            this.lastSuccessfulWriteAt = createdAt;
        }

        SseEmitter emitter() {
            return emitter;
        }

        String actorKey() {
            return actorKey;
        }

        String clientIp() {
            return clientIp;
        }

        String streamClientId() {
            return streamClientId;
        }

        Instant createdAt() {
            return createdAt;
        }

        Instant lastSuccessfulWriteAt() {
            return lastSuccessfulWriteAt;
        }

        void markWriteSucceeded(Instant at) {
            lastSuccessfulWriteAt = at;
        }
    }

    private record Replacement(Subscription subscription, ReplacementReason reason) {
    }

    private enum ReplacementReason {
        SAME_CLIENT("same_client"),
        STALE_CAPACITY("stale_capacity");

        private final String metricValue;

        ReplacementReason(String metricValue) {
            this.metricValue = metricValue;
        }

        String metricValue() {
            return metricValue;
        }
    }

    private enum LimitScope {
        GLOBAL("global"),
        TRIP("trip"),
        CLIENT_IP("client_ip"),
        ACTOR_TRIP("actor_trip");

        private final String metricValue;

        LimitScope(String metricValue) {
            this.metricValue = metricValue;
        }

        String metricValue() {
            return metricValue;
        }
    }

    public static class StreamLimitExceededException extends RuntimeException {
    }
}
