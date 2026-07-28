package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.actuate.autoconfigure.endpoint.EndpointAutoConfiguration;
import org.springframework.boot.actuate.autoconfigure.health.HealthEndpointAutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class HealthGroupValidationConfigTest {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(
            EndpointAutoConfiguration.class,
            HealthEndpointAutoConfiguration.class))
        .withPropertyValues("management.endpoint.health.group.database.include=db");

    @Test
    void missingDatabaseContributorFailsByDefault() {
        contextRunner.run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure())
                .hasMessageContaining("Included health contributor 'db'")
                .hasMessageContaining("group 'database'");
        });
    }

    @Test
    void testProfileValidationSwitchAllowsAContextWithoutDataSource() {
        contextRunner
            .withPropertyValues("management.endpoint.health.validate-group-membership=false")
            .run(context -> assertThat(context).hasNotFailed());
    }
}
