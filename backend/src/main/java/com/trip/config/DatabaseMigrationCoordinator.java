package com.trip.config;

import java.sql.Connection;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
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
    private final AtomicBoolean failureLogged = new AtomicBoolean();
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
            if (!ready.get() || !canConnect()) {
                markDown();
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
        executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "database-readiness");
            thread.setDaemon(true);
            return thread;
        });
        scheduleRetry(0);
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
        if (ready.get() || !checkLock.tryLock()) {
            return;
        }
        try {
            if (ready.get()) {
                return;
            }
            DataSource dataSource = dataSourceSupplier.get();
            if (dataSource == null || !canConnect(dataSource)) {
                markDown();
                scheduleRetry();
                return;
            }
            // Close the connectivity probe before Flyway obtains its own connection.
            flyway(dataSource).migrate();
            if (ready.compareAndSet(false, true)) {
                failureLogged.set(false);
                LOG.info("Database readiness is UP");
                publishReady();
            }
        } catch (Exception ex) {
            markDown();
            scheduleRetry();
        } finally {
            checkLock.unlock();
        }
    }

    private boolean canConnect() {
        DataSource dataSource = dataSourceSupplier.get();
        return dataSource != null && canConnect(dataSource);
    }

    private static boolean canConnect(DataSource dataSource) {
        try (Connection ignored = dataSource.getConnection()) {
            return true;
        } catch (Exception ex) {
            return false;
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

    private void markDown() {
        boolean wasReady = ready.getAndSet(false);
        if (wasReady || failureLogged.compareAndSet(false, true)) {
            LOG.warn("Database readiness is DOWN; retrying in {} ms", retryMillis);
        }
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
            LOG.warn("Database-ready listener failed");
        }
    }
}
