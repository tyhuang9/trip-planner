package com.trip.config;

import java.time.Duration;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnBean(DataSource.class)
class DatabaseResilienceConfig {

    @Bean
    Flyway flyway(DataSource dataSource) {
        return Flyway.configure()
            .dataSource(dataSource)
            .locations("classpath:db/migration")
            .baselineOnMigrate(false)
            .load();
    }

    @Bean
    DatabaseMigrationCoordinator databaseMigrationCoordinator(
            DataSource dataSource,
            Flyway flyway,
            @Value("${app.database.check-interval-ms:5000}") long checkIntervalMillis) {
        return new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofMillis(checkIntervalMillis));
    }

    @Bean
    HealthIndicator databaseHealthIndicator(DatabaseMigrationCoordinator coordinator) {
        return coordinator;
    }
}
