package com.trip.config;

import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;

/**
 * Central registry of named rate-limit buckets (Bucket4j, in-memory).
 *
 * <p>Piece 1 only wires the infrastructure and registers the bucket <em>definitions</em>
 * the plan calls out ({@code auth-login}, {@code auth-register}, {@code share-accept},
 * {@code guest-write}). Piece 2+ will consume them from filters / interceptors on
 * the actual endpoints. Until then, {@link RateLimitFilter} is a no-op pass-through,
 * so this class also has no runtime effect — but the configuration lives here so
 * wiring an endpoint later is a one-liner.
 *
 * <p>Keys are {@code "{bucketName}:{discriminator}"}, where the discriminator is
 * typically {@code ip} or {@code ip:email}. Each named bucket family has a hard
 * discriminator cap plus an overflow bucket; a scheduled sweep ({@link #evictIdle()})
 * drops entries that have been idle longer than {@link #MAX_IDLE} so a sustained scan
 * against many IPs can't grow the map without bound.
 */
@Component
public class RateLimitRegistry {

    /**
     * Idle threshold for eviction. One hour comfortably covers the 15-minute login
     * window and the 1-hour register window — an entry older than this can't possibly
     * still be enforcing a recent limit, so dropping it just makes the next request
     * from that key lazily re-allocate a fresh bucket.
     */
    static final Duration MAX_IDLE = Duration.ofHours(1);
    static final int DEFAULT_MAX_BUCKETS_PER_NAME = 4096;
    static final String OVERFLOW_DISCRIMINATOR = "__overflow__";

    /**
     * Definitions of the named buckets. All values mirror §5 of the plan. Each is a
     * {@link Supplier} so a fresh {@link Bucket} is built per key.
     */
    public enum Named {
        /**
         * 5 login attempts per 15 minutes, keyed on client IP only. Outer per-IP backstop
         * enforced by {@link RateLimitFilter}; defeats brute-force from one host across
         * many accounts (the email-rotation evasion shape against the per-identity cap).
         * See sibling {@link #AUTH_LOGIN_PER_IDENTITY} for the inner per-(ip, email) layer.
         */
        AUTH_LOGIN(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(5).refillGreedy(5, Duration.ofMinutes(15)).build())
            .build()),

        /**
         * 5 login attempts per 15 minutes, keyed on {@code (ip, normalizedEmail)}.
         * Inner per-identity layer enforced by {@code AuthController.login}; rejects a
         * focused brute-force against a specific account from a specific host. Same
         * numerical limit as {@link #AUTH_LOGIN} but distinct keying so the two ceilings
         * are tunable independently.
         */
        AUTH_LOGIN_PER_IDENTITY(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(5).refillGreedy(5, Duration.ofMinutes(15)).build())
            .build()),

        /** 10 registrations per hour per IP. */
        AUTH_REGISTER(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(10).refillGreedy(10, Duration.ofHours(1)).build())
            .build()),

        /** 10 password reset requests per minute per IP before body parsing. */
        AUTH_PASSWORD_RESET_REQUEST(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(10).refillGreedy(10, Duration.ofMinutes(1)).build())
            .build()),

        /** 3 password reset requests per hour per {@code (ip, normalizedEmail)}. */
        AUTH_PASSWORD_RESET_REQUEST_PER_EMAIL(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(3).refillGreedy(3, Duration.ofHours(1)).build())
            .build()),

        /** 10 password reset confirmations per minute per IP. */
        AUTH_PASSWORD_RESET_CONFIRM(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(10).refillGreedy(10, Duration.ofMinutes(1)).build())
            .build()),

        /** 10 email verification submissions per minute per IP. */
        AUTH_EMAIL_VERIFICATION_VERIFY(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(10).refillGreedy(10, Duration.ofMinutes(1)).build())
            .build()),

        /** 10 email verification resend requests per minute per IP. */
        AUTH_EMAIL_VERIFICATION_RESEND(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(10).refillGreedy(10, Duration.ofMinutes(1)).build())
            .build()),

        /** 5 email verification resend requests per hour per {@code (ip, normalizedEmail)}. */
        AUTH_EMAIL_VERIFICATION_RESEND_PER_EMAIL(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(5).refillGreedy(5, Duration.ofHours(1)).build())
            .build()),

        /** 60 refresh attempts per minute per IP. */
        AUTH_REFRESH(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(60).refillGreedy(60, Duration.ofMinutes(1)).build())
            .build()),

        /** 120 logout attempts per minute per IP. */
        AUTH_LOGOUT(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(120).refillGreedy(120, Duration.ofMinutes(1)).build())
            .build()),

        /** 60 local dev login-as attempts per minute per IP. Local profile only. */
        AUTH_DEV_LOGIN_AS(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(60).refillGreedy(60, Duration.ofMinutes(1)).build())
            .build()),

        /** 60 local dev user-management attempts per minute per IP. Local profile only. */
        AUTH_DEV_USERS(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(60).refillGreedy(60, Duration.ofMinutes(1)).build())
            .build()),

        /** 10 share-accept / guest-join attempts per minute per IP before token validation. */
        SHARE_ACCEPT(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(10).refillGreedy(10, Duration.ofMinutes(1)).build())
            .build()),

        /** 60 guest writes per minute per IP before guest-session validation. */
        GUEST_WRITE(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(60).refillGreedy(60, Duration.ofMinutes(1)).build())
            .build()),

        /** 120 backend-proxied Google Maps calls per minute per IP. */
        GOOGLE_MAPS(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(120).refillGreedy(120, Duration.ofMinutes(1)).build())
            .build()),

        /** 30 public database health probes per minute per IP. */
        HEALTH_DATABASE(() -> Bucket.builder()
            .addLimit(Bandwidth.builder().capacity(30).refillGreedy(30, Duration.ofMinutes(1)).build())
            .build());

        private final Supplier<Bucket> factory;

        Named(Supplier<Bucket> factory) {
            this.factory = factory;
        }

        Bucket newBucket() {
            return factory.get();
        }
    }

    /**
     * Bucket plus a last-access timestamp. The timestamp is updated on every
     * {@link #resolve(Named, String)} call so {@link #evictIdle()} can distinguish
     * recently-used entries from abandoned ones.
     */
    record TrackedBucket(Bucket bucket, AtomicLong lastAccessMillis) { }

    private final Map<String, TrackedBucket> buckets = new ConcurrentHashMap<>();
    private final Clock clock;
    private final int maxBucketsPerName;

    public RateLimitRegistry() {
        this(Clock.systemUTC());
    }

    /**
     * Test seam: inject a fixed/controllable clock. Production wiring uses the
     * no-arg constructor.
     */
    RateLimitRegistry(Clock clock) {
        this(clock, DEFAULT_MAX_BUCKETS_PER_NAME);
    }

    RateLimitRegistry(Clock clock, int maxBucketsPerName) {
        this.clock = clock;
        this.maxBucketsPerName = maxBucketsPerName;
    }

    /**
     * Returns the bucket for {@code (name, discriminator)}, creating it on first use.
     * Callers pass something stable and scoped — e.g., {@code clientIp} — to
     * differentiate offenders while still allowing a shared pool where appropriate.
     */
    public synchronized Bucket resolve(Named name, String discriminator) {
        String key = keyFor(name, discriminator);
        if (!buckets.containsKey(key) && bucketCount(name) >= maxBucketsPerName) {
            key = keyFor(name, OVERFLOW_DISCRIMINATOR);
        }
        long now = clock.millis();
        TrackedBucket tracked = buckets.computeIfAbsent(key,
            k -> new TrackedBucket(name.newBucket(), new AtomicLong(now)));
        tracked.lastAccessMillis().set(now);
        return tracked.bucket();
    }

    /**
     * Drops bucket entries that haven't been touched in {@link #MAX_IDLE}. Runs every
     * 15 minutes via Spring's scheduler (see {@link com.trip.Application}, which
     * declares {@code @EnableScheduling}). Idempotent — concurrent scans / accesses
     * just race on the {@link ConcurrentHashMap} contract.
     */
    @Scheduled(fixedDelayString = "PT15M")
    public synchronized void evictIdle() {
        long cutoff = clock.millis() - MAX_IDLE.toMillis();
        buckets.entrySet().removeIf(e -> e.getValue().lastAccessMillis().get() < cutoff);
    }

    /** Visible for tests — current entry count. */
    int size() {
        return buckets.size();
    }

    private static String keyFor(Named name, String discriminator) {
        return name.name() + ":" + discriminator;
    }

    private long bucketCount(Named name) {
        String prefix = name.name() + ":";
        return buckets.keySet().stream()
            .filter(key -> key.startsWith(prefix))
            .count();
    }
}
