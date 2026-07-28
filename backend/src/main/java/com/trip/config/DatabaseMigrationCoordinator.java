package com.trip.config;

import java.sql.Connection;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.context.SmartLifecycle;

/**
 * Keeps database readiness separate from JVM liveness. The sole worker checks
 * connectivity and runs Flyway before declaring the database available.
 */
final class DatabaseMigrationCoordinator implements HealthIndicator, SmartLifecycle {

    private static final Logger LOG = LoggerFactory.getLogger(DatabaseMigrationCoordinator.class);

    private final DataSource dataSource;
    private final Flyway flyway;
    private final long retryMillis;
    private final AtomicBoolean ready = new AtomicBoolean();
    private final AtomicBoolean running = new AtomicBoolean();
    private ScheduledExecutorService executor;

    DatabaseMigrationCoordinator(DataSource dataSource, Flyway flyway, Duration retryInterval) {
        this.dataSource = dataSource;
        this.flyway = flyway;
        this.retryMillis = Math.max(1_000L, retryInterval.toMillis());
    }

    @Override
    public Health health() {
        return ready.get() ? Health.up().build() : Health.down().build();
    }

    @Override
    public void start() {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "database-readiness");
            thread.setDaemon(true);
            return thread;
        });
        executor.scheduleWithFixedDelay(this::refresh, 0, retryMillis, TimeUnit.MILLISECONDS);
    }

    @Override
    public void stop() {
        if (running.compareAndSet(true, false) && executor != null) {
            executor.shutdownNow();
        }
    }

    @Override
    public boolean isRunning() {
        return running.get();
    }

    @Override
    public boolean isAutoStartup() {
        return true;
    }

    @Override
    public int getPhase() {
        return Integer.MAX_VALUE;
    }

    void refresh() {
        try (Connection ignored = dataSource.getConnection()) {
            flyway.migrate();
            if (ready.compareAndSet(false, true)) {
                LOG.info("Database readiness is UP");
            }
        } catch (Exception ex) {
            if (ready.getAndSet(false)) {
                LOG.warn("Database readiness is DOWN");
            }
        }
    }
}
