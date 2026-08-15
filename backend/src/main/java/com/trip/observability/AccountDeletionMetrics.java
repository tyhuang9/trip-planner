package com.trip.observability;

import java.util.EnumMap;
import java.util.Map;
import java.util.Objects;

import org.springframework.stereotype.Component;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;

/**
 * Low-cardinality account-deletion attempt metrics.
 *
 * <p>All allowed outcome series are registered at construction time. Callers can only
 * record a fixed enum value, preventing request or identity data from becoming metric
 * tags. {@code ip_throttled} is a route-level edge rejection recorded before Spring
 * Security authentication, so it must not be interpreted as an authenticated-user
 * outcome.
 */
@Component
public final class AccountDeletionMetrics {

    private static final String COUNTER_NAME = "dupert.auth.account.deletion.attempts";
    private static final String OUTCOME_TAG = "outcome";

    private final Map<Outcome, Counter> counters;

    public AccountDeletionMetrics(MeterRegistry meterRegistry) {
        EnumMap<Outcome, Counter> registeredCounters = new EnumMap<>(Outcome.class);
        for (Outcome outcome : Outcome.values()) {
            Counter counter = Counter.builder(COUNTER_NAME)
                .description("Account deletion attempts by fixed outcome")
                .tag(OUTCOME_TAG, outcome.metricValue)
                .register(meterRegistry);
            registeredCounters.put(outcome, counter);
        }
        this.counters = Map.copyOf(registeredCounters);
    }

    public void record(Outcome outcome) {
        counters.get(Objects.requireNonNull(outcome, "outcome")).increment();
    }

    public enum Outcome {
        SUCCESS("success"),
        FRESH_AUTH_REJECTED("fresh_auth_rejected"),
        USER_MISSING("user_missing"),
        USER_THROTTLED("user_throttled"),
        /** Outer client-IP limit rejected the route before authentication. */
        IP_THROTTLED("ip_throttled"),
        TRANSACTION_FAILED("transaction_failed");

        private final String metricValue;

        Outcome(String metricValue) {
            this.metricValue = metricValue;
        }
    }
}
