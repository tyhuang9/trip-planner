package com.trip.observability;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import org.junit.jupiter.api.Test;

import com.trip.observability.AccountDeletionMetrics.Outcome;

import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;

class AccountDeletionMetricsTest {

    private static final String COUNTER_NAME = "dupert.auth.account.deletion.attempts";

    @Test
    void preRegistersOnlyTheFixedOutcomeSeriesAndRecordsByEnum() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        AccountDeletionMetrics metrics = new AccountDeletionMetrics(registry);
        Map<Outcome, String> expectedOutcomes = Map.of(
            Outcome.SUCCESS, "success",
            Outcome.FRESH_AUTH_REJECTED, "fresh_auth_rejected",
            Outcome.USER_MISSING, "user_missing",
            Outcome.USER_THROTTLED, "user_throttled",
            Outcome.IP_THROTTLED, "ip_throttled",
            Outcome.TRANSACTION_FAILED, "transaction_failed");

        assertThat(registry.getMeters()).hasSize(expectedOutcomes.size());
        assertThat(registry.getMeters())
            .extracting(meter -> meter.getId().getName())
            .containsOnly(COUNTER_NAME);
        assertThat(registry.getMeters())
            .extracting(meter -> meter.getId().getType())
            .containsOnly(Meter.Type.COUNTER);
        assertThat(registry.getMeters())
            .extracting(meter -> meter.getId().getTag("outcome"))
            .containsExactlyInAnyOrderElementsOf(expectedOutcomes.values());
        assertThat(registry.getMeters())
            .allSatisfy(meter -> assertFixedOutcomeTag(meter, expectedOutcomes));

        expectedOutcomes.forEach((outcome, metricValue) -> {
            assertThat(registry.get(COUNTER_NAME)
                    .tag("outcome", metricValue).counter().count())
                .isZero();
            metrics.record(outcome);
            assertThat(registry.get(COUNTER_NAME)
                    .tag("outcome", metricValue).counter().count())
                .isEqualTo(1.0);
        });
    }

    private static void assertFixedOutcomeTag(Meter meter,
                                              Map<Outcome, String> expectedOutcomes) {
        assertThat(meter.getId().getTags()).singleElement().satisfies(tag -> {
            assertThat(tag.getKey()).isEqualTo("outcome");
            assertThat(tag.getValue()).isIn(expectedOutcomes.values());
        });
    }
}
