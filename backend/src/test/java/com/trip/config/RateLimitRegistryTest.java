package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import org.junit.jupiter.api.Test;

import io.github.bucket4j.Bucket;

/**
 * Unit tests for the eviction sweep in {@link RateLimitRegistry}. Pure logic; uses
 * a {@link Clock}-driven test seam rather than {@code Thread.sleep} so the tests
 * stay deterministic and fast.
 */
class RateLimitRegistryTest {

    /**
     * Mutable clock that returns whatever {@link Instant} the test most recently set.
     * Bucket4j's internal time source is not driven by this clock — but eviction is,
     * which is the only behavior under test here.
     */
    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration d) {
            this.now = this.now.plus(d);
        }

        @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    @Test
    void evictIdleRemovesEntriesOlderThanThreshold() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        RateLimitRegistry registry = new RateLimitRegistry(clock);

        registry.resolve(RateLimitRegistry.Named.AUTH_LOGIN, "1.2.3.4");
        assertThat(registry.size()).isEqualTo(1);

        // Advance past the idle threshold (1 hour) — sweep should drop the entry.
        clock.advance(RateLimitRegistry.MAX_IDLE.plusMinutes(1));
        registry.evictIdle();

        assertThat(registry.size()).isZero();
    }

    @Test
    void evictIdleKeepsEntriesWithinThreshold() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        RateLimitRegistry registry = new RateLimitRegistry(clock);

        registry.resolve(RateLimitRegistry.Named.AUTH_REGISTER, "5.6.7.8");
        assertThat(registry.size()).isEqualTo(1);

        // Advance, but stay under the idle threshold.
        clock.advance(RateLimitRegistry.MAX_IDLE.minusMinutes(1));
        registry.evictIdle();

        assertThat(registry.size()).isEqualTo(1);
    }

    @Test
    void resolveRefreshesLastAccessSoActiveKeysSurviveSweep() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        RateLimitRegistry registry = new RateLimitRegistry(clock);

        registry.resolve(RateLimitRegistry.Named.AUTH_LOGIN, "9.9.9.9");

        // Drift forward, but resolve again before the sweep — that should bump
        // lastAccess so the entry survives.
        clock.advance(RateLimitRegistry.MAX_IDLE.minusMinutes(5));
        registry.resolve(RateLimitRegistry.Named.AUTH_LOGIN, "9.9.9.9");

        clock.advance(Duration.ofMinutes(10));
        registry.evictIdle();

        assertThat(registry.size()).isEqualTo(1);
    }

    @Test
    void resolveUsesOverflowBucketAfterPerNameCap() {
        MutableClock clock = new MutableClock(Instant.parse("2026-01-01T00:00:00Z"));
        RateLimitRegistry registry = new RateLimitRegistry(clock, 2);

        Bucket first = registry.resolve(RateLimitRegistry.Named.AUTH_LOGIN, "1.2.3.4");
        Bucket second = registry.resolve(RateLimitRegistry.Named.AUTH_LOGIN, "5.6.7.8");
        Bucket overflow = registry.resolve(RateLimitRegistry.Named.AUTH_LOGIN, "9.9.9.9");
        Bucket sameOverflow = registry.resolve(RateLimitRegistry.Named.AUTH_LOGIN, "10.10.10.10");

        assertThat(registry.size()).isEqualTo(3);
        assertThat(overflow).isSameAs(sameOverflow);
        assertThat(overflow).isNotSameAs(first);
        assertThat(overflow).isNotSameAs(second);
    }

    @Test
    void accountDeletionBucketsHaveIndependentApprovedCapacities() {
        RateLimitRegistry registry = new RateLimitRegistry();
        Bucket perIp = registry.resolve(
            RateLimitRegistry.Named.AUTH_ACCOUNT_DELETE, "203.0.113.41");
        Bucket perUser = registry.resolve(
            RateLimitRegistry.Named.AUTH_ACCOUNT_DELETE_PER_USER, "42");

        assertThat(perIp.getAvailableTokens()).isEqualTo(10);
        assertThat(perUser.getAvailableTokens()).isEqualTo(5);
    }
}
