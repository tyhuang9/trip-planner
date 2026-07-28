package com.trip.config;

import java.sql.Connection;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Keeps database readiness separate from JVM liveness. Retries run only while
 * unavailable; ready health checks probe connectivity without rerunning Flyway.
 */
@Component("databaseHealthIndicator")
final class DatabaseMigrationCoordinator implements HealthIndicator, SmartLifecycle {

    private static final Logger LOG = LoggerFactory.getLogger(DatabaseMigrationCoordinator.class);

    private final Supplier<DataSource> dataSourceSupplier;
    private final ApplicationEventPublisher events;
    private final long retryMillis;
    private final AtomicBoolean ready = new AtomicBoolean();
    private final AtomicBoolean running = new AtomicBoolean();
    private final AtomicBoolean everReady = new AtomicBoolean();
    private final AtomicReference<FailureEvent> loggedFailure = new AtomicReference<>();
    private final ReentrantLock checkLock = new ReentrantLock();
    private final Object retryMonitor = new Object();
    private Flyway flyway;
    private ScheduledExecutorService executor;
    private ScheduledFuture<?> retry;

    @Autowired
    DatabaseMigrationCoordinator(ObjectProvider<DataSource> dataSourceProvider,
                                 ApplicationEventPublisher events,
                                 @Value("${app.database.check-interval-ms:5000}") long checkIntervalMillis) {
        this(dataSourceProvider::getIfAvailable, null, events, Duration.ofMillis(checkIntervalMillis));
    }

    DatabaseMigrationCoordinator(DataSource dataSource, Flyway flyway, Duration retryInterval) {
        this(() -> dataSource, flyway, event -> { }, retryInterval);
    }

    DatabaseMigrationCoordinator(DataSource dataSource,
                                 Flyway flyway,
                                 ApplicationEventPublisher events,
                                 Duration retryInterval) {
        this(() -> dataSource, flyway, events, retryInterval);
    }

    private DatabaseMigrationCoordinator(Supplier<DataSource> dataSourceSupplier,
                                         Flyway flyway,
                                         ApplicationEventPublisher events,
                                         Duration retryInterval) {
        this.dataSourceSupplier = dataSourceSupplier;
        this.flyway = flyway;
        this.events = events;
        this.retryMillis = Math.max(1_000L, retryInterval.toMillis());
    }

    @Override
    public Health health() {
        if (!ready.get() || !checkLock.tryLock()) {
            return status();
        }
        try {
            ConnectionProbe probe = probeConnection();
            if (!ready.get() || !probe.connected()) {
                markDown(probe.exceptionType());
                scheduleRetry();
            }
            return status();
        } finally {
            checkLock.unlock();
        }
    }

    @Override
    public void start() {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        LOG.info("event=coordinator_started retry_delay_ms={}", retryMillis);
        executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "database-readiness");
            thread.setDaemon(true);
            return thread;
        });
        scheduleRetry(0);
    }

    @Override
    public void stop() {
        if (!running.compareAndSet(true, false)) {
            return;
        }
        LOG.info("event=coordinator_stopping");
        if (executor != null) {
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
        if (ready.get() || !checkLock.tryLock()) {
            return;
        }
        try {
            if (ready.get()) {
                return;
            }
            DataSource dataSource;
            try {
                dataSource = dataSourceSupplier.get();
            } catch (Exception ex) {
                databaseUnavailable(exceptionType(ex));
                return;
            }
            ConnectionProbe probe = probe(dataSource);
            if (!probe.connected()) {
                databaseUnavailable(probe.exceptionType());
                return;
            }
            try {
                // Close the connectivity probe before Flyway obtains its own connection.
                flyway(dataSource).migrate();
            } catch (Exception ex) {
                logFailure(FailureEvent.MIGRATION_FAILED, exceptionType(ex));
                ready.set(false);
                scheduleRetry();
                return;
            }
            if (ready.compareAndSet(false, true)) {
                everReady.set(true);
                if (loggedFailure.getAndSet(null) != null) {
                    LOG.info("event=recovered");
                }
                publishReady();
            }
        } finally {
            checkLock.unlock();
        }
    }

    private ConnectionProbe probeConnection() {
        try {
            return probe(dataSourceSupplier.get());
        } catch (Exception ex) {
            return new ConnectionProbe(false, exceptionType(ex));
        }
    }

    private static ConnectionProbe probe(DataSource dataSource) {
        if (dataSource == null) {
            return new ConnectionProbe(false, "none");
        }
        try (Connection ignored = dataSource.getConnection()) {
            return new ConnectionProbe(true, "none");
        } catch (Exception ex) {
            return new ConnectionProbe(false, exceptionType(ex));
        }
    }

    private Flyway flyway(DataSource dataSource) {
        if (flyway != null) {
            return flyway;
        }
        synchronized (this) {
            if (flyway == null) {
                flyway = Flyway.configure()
                    .dataSource(dataSource)
                    .locations("classpath:db/migration")
                    .baselineOnMigrate(false)
                    .load();
            }
            return flyway;
        }
    }

    private Health status() {
        return ready.get() ? Health.up().build() : Health.down().build();
    }

    private void markDown(String exceptionType) {
        boolean wasReady = ready.getAndSet(false);
        if (wasReady) {
            logFailure(FailureEvent.HEALTHY_TO_DOWN, exceptionType);
        }
    }

    private void databaseUnavailable(String exceptionType) {
        ready.set(false);
        if (!everReady.get()) {
            logFailure(FailureEvent.STARTUP_DB_UNAVAILABLE, exceptionType);
        }
        scheduleRetry();
    }

    private void logFailure(FailureEvent failure, String exceptionType) {
        if (loggedFailure.getAndSet(failure) != failure) {
            LOG.warn("event={} retry_delay_ms={} exception_type={}",
                failure.eventName, retryMillis, exceptionType);
        }
    }

    private static String exceptionType(Exception ex) {
        String simpleName = ex.getClass().getSimpleName();
        return simpleName.isEmpty() ? "unknown" : simpleName;
    }

    private void scheduleRetry() {
        scheduleRetry(retryMillis);
    }

    private void scheduleRetry(long delayMillis) {
        if (!running.get()) {
            return;
        }
        synchronized (retryMonitor) {
            if (retry == null || retry.isDone()) {
                retry = executor.schedule(() -> {
                    synchronized (retryMonitor) {
                        retry = null;
                    }
                    refresh();
                }, delayMillis, TimeUnit.MILLISECONDS);
            }
        }
    }

    private void publishReady() {
        try {
            events.publishEvent(new DatabaseReadyEvent(this));
        } catch (RuntimeException ex) {
            LOG.warn("event=listener_failed exception_type={}", exceptionType(ex));
        }
    }

    private record ConnectionProbe(boolean connected, String exceptionType) {
    }

    private enum FailureEvent {
        STARTUP_DB_UNAVAILABLE("startup_db_unavailable"),
        HEALTHY_TO_DOWN("healthy_to_down"),
        MIGRATION_FAILED("migration_failed");

        private final String eventName;

        FailureEvent(String eventName) {
            this.eventName = eventName;
        }
    }
}
