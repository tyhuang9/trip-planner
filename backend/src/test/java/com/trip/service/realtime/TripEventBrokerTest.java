package com.trip.service.realtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;

import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.trip.config.AppProperties;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;

class TripEventBrokerTest {

    private static final Instant START = Instant.parse("2026-07-17T12:00:00Z");

    @Test
    void subscribeTracksEmittersAndActiveGauge() {
        BrokerFixture fixture = fixture();

        SseEmitter emitter = fixture.broker().subscribe(
            42L, "user:1", "203.0.113.10", "mobile-client-0001");

        assertThat(fixture.broker().subscriberCountForTest(42L)).isEqualTo(1);
        assertThat(fixture.broker().globalSubscriberCountForTest()).isEqualTo(1);
        assertThat(fixture.registry().get("dupert.sse.subscriptions.active").gauge().value())
            .isEqualTo(1.0);
        emitter.complete();
    }

    @Test
    void publishWithoutSubscribersIsNoOp() {
        BrokerFixture fixture = fixture();

        fixture.broker().publish(
            42L,
            TripEvent.activityUpdated("abc23def45gh", 10L, LocalDate.of(2026, 5, 1)));

        assertThat(fixture.broker().subscriberCountForTest(42L)).isZero();
    }

    @Test
    void disconnectRemovesTripSubscribers() {
        BrokerFixture fixture = fixture();
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0001");
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0002");

        fixture.broker().disconnect(42L);

        assertThat(fixture.broker().subscriberCountForTest(42L)).isZero();
        assertThat(fixture.broker().globalSubscriberCountForTest()).isZero();
    }

    @Test
    void heartbeatRefreshesSuccessfulWriteTimestamp() {
        BrokerFixture fixture = fixture();
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0001");
        fixture.clock().advance(Duration.ofSeconds(15));

        fixture.broker().maintainSubscriptions();

        assertThat(fixture.broker().subscriberCountForTest(42L)).isEqualTo(1);
        assertThat(fixture.broker().lastSuccessfulWriteForTest(42L))
            .isEqualTo(START.plusSeconds(15));
        assertThat(fixture.registry().get("dupert.sse.heartbeats.sent").counter().count())
            .isEqualTo(1.0);
    }

    @Test
    void maintenanceRemovesConnectionThatMissedDocumentedStaleInterval() {
        BrokerFixture fixture = fixture();
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0001");
        fixture.clock().advance(Duration.ofSeconds(30));

        fixture.broker().maintainSubscriptions();

        assertThat(fixture.broker().subscriberCountForTest(42L)).isZero();
        assertThat(fixture.broker().globalSubscriberCountForTest()).isZero();
        assertThat(fixture.registry().get("dupert.sse.subscriptions.stale").counter().count())
            .isEqualTo(1.0);
    }

    @Test
    void maintenanceForcesRenewalAtMaximumLifetime() {
        BrokerFixture fixture = fixture();
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0001");
        fixture.clock().advance(Duration.ofMinutes(2));

        fixture.broker().maintainSubscriptions();

        assertThat(fixture.broker().subscriberCountForTest(42L)).isZero();
        assertThat(fixture.registry().get("dupert.sse.subscriptions.expired").counter().count())
            .isEqualTo(1.0);
    }

    @Test
    void repeatedSameClientReconnectsReplacePredecessorWithoutUsingCapacity() {
        BrokerFixture fixture = fixture();

        for (int index = 0; index < 20; index++) {
            fixture.broker().subscribe(
                42L, "user:1", "203.0.113.10", "mobile-client-0001");
        }

        assertThat(fixture.broker().subscriberCountForTest(42L)).isEqualTo(1);
        assertThat(fixture.broker().globalSubscriberCountForTest()).isEqualTo(1);
        assertThat(fixture.registry().get("dupert.sse.subscriptions.replaced")
                .tag("reason", "same_client").counter().count())
            .isEqualTo(19.0);
    }

    @Test
    void oldestStaleActorConnectionIsReplacedAtActorLimit() {
        BrokerFixture fixture = fixture();
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0001");
        fixture.clock().advance(Duration.ofSeconds(1));
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0002");
        fixture.clock().advance(Duration.ofSeconds(30));

        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0003");

        assertThat(fixture.broker().subscriberCountForTest(42L)).isEqualTo(2);
        assertThat(fixture.registry().get("dupert.sse.subscriptions.replaced")
                .tag("reason", "stale_capacity").counter().count())
            .isEqualTo(1.0);
    }

    @Test
    void freshActorCapacityRemainsBoundedAndObservable() {
        BrokerFixture fixture = fixture();
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0001");
        fixture.broker().subscribe(42L, "user:1", "203.0.113.10", "mobile-client-0002");

        assertThatThrownBy(() -> fixture.broker().subscribe(
            42L, "user:1", "203.0.113.10", "mobile-client-0003"))
            .isInstanceOf(TripEventBroker.StreamLimitExceededException.class);

        assertThat(fixture.broker().subscriberCountForTest(42L)).isEqualTo(2);
        assertThat(fixture.registry().get("dupert.sse.subscriptions.rejected")
                .tag("scope", "actor_trip").counter().count())
            .isEqualTo(1.0);
    }

    @Test
    void limitsSubscriptionsPerClientIpAcrossActors() {
        BrokerFixture fixture = fixture();
        for (int index = 0; index < TripEventBroker.MAX_SUBSCRIBERS_PER_IP; index++) {
            fixture.broker().subscribe(
                42L,
                "user:" + index,
                "203.0.113.10",
                "mobile-client-" + String.format("%04d", index));
        }

        assertThatThrownBy(() -> fixture.broker().subscribe(
            42L, "user:overflow", "203.0.113.10", "mobile-client-overflow"))
            .isInstanceOf(TripEventBroker.StreamLimitExceededException.class);

        assertThat(fixture.broker().subscriberCountForTest(42L))
            .isEqualTo(TripEventBroker.MAX_SUBSCRIBERS_PER_IP);
        assertThat(fixture.broker().globalSubscriberCountForTest())
            .isEqualTo(TripEventBroker.MAX_SUBSCRIBERS_PER_IP);
        assertThat(fixture.registry().get("dupert.sse.subscriptions.rejected")
                .tag("scope", "client_ip").counter().count())
            .isEqualTo(1.0);
    }

    private static BrokerFixture fixture() {
        AppProperties properties = new AppProperties();
        properties.getRealtime().setStaleAfter(Duration.ofSeconds(30));
        properties.getRealtime().setMaxLifetime(Duration.ofMinutes(2));
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MutableClock clock = new MutableClock(START);
        return new BrokerFixture(
            new TripEventBroker(properties, registry, clock), registry, clock);
    }

    private record BrokerFixture(
            TripEventBroker broker,
            SimpleMeterRegistry registry,
            MutableClock clock) {
    }

    private static final class MutableClock extends Clock {
        private Instant instant;

        private MutableClock(Instant instant) {
            this.instant = instant;
        }

        void advance(Duration duration) {
            instant = instant.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return instant;
        }
    }
}
