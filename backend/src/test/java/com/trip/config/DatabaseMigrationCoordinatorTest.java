package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import javax.sql.DataSource;

import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mockito;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ApplicationEventPublisher;

@ExtendWith(OutputCaptureExtension.class)
class DatabaseMigrationCoordinatorTest {

    private DatabaseMigrationCoordinator coordinator;

    @AfterEach
    void stopCoordinator() {
        if (coordinator != null) {
            coordinator.stop();
        }
    }

    @Test
    void staysDownWhenDatabaseIsUnavailableAtStartup() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection()).thenThrow(new SQLException("unavailable"));
        Flyway flyway = mock(Flyway.class);
        coordinator = new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofSeconds(1));

        coordinator.refresh();

        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("DOWN");
    }

    @Test
    void marksDatabaseDownOnLossAndUpOnlyAfterMigrationSucceedsAgain() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        Connection connection = mock(Connection.class);
        when(dataSource.getConnection())
            .thenReturn(connection)
            .thenReturn(connection)
            .thenThrow(new SQLException("unavailable"))
            .thenReturn(connection)
            .thenReturn(connection);
        Flyway flyway = mock(Flyway.class);
        coordinator = new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofSeconds(1));

        coordinator.refresh();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("UP");

        coordinator.health();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("DOWN");

        coordinator.refresh();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("UP");
        verify(flyway, times(2)).migrate();
    }

    @Test
    void remainsDownUntilAMigrationCanComplete() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection()).thenReturn(mock(Connection.class));
        Flyway flyway = mock(Flyway.class);
        when(flyway.migrate())
            .thenThrow(new org.flywaydb.core.api.FlywayException("migration failed"))
            .thenReturn(null);
        coordinator = new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofSeconds(1));

        coordinator.refresh();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("DOWN");

        coordinator.refresh();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("UP");
    }

    @Test
    void startsWithoutWaitingForABlockedDatabaseCheck(CapturedOutput output) throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection()).thenAnswer(invocation -> {
            entered.countDown();
            release.await(5, TimeUnit.SECONDS);
            throw new SQLException("unavailable");
        });
        coordinator = new DatabaseMigrationCoordinator(dataSource, mock(Flyway.class), Duration.ofSeconds(1));

        long startedAt = System.nanoTime();
        coordinator.start();

        assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)).isLessThan(250L);
        assertThat(entered.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("DOWN");
        release.countDown();
        awaitOutputContains(output, "event=startup_db_unavailable");
    }

    @Test
    void closesTheProbeBeforeFlywayUsesThePool() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        Connection connection = mock(Connection.class);
        when(dataSource.getConnection()).thenReturn(connection);
        Flyway flyway = mock(Flyway.class);
        doAnswer(invocation -> {
            verify(connection).close();
            return null;
        }).when(flyway).migrate();
        coordinator = new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofSeconds(1));

        coordinator.refresh();

        InOrder calls = Mockito.inOrder(connection, flyway);
        calls.verify(connection).close();
        calls.verify(flyway).migrate();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("UP");
    }

    @Test
    @Timeout(6)
    void waitsForHikariConnectionTimeoutThenReturnsDownWhenPoolIsSaturated() throws Exception {
        DataSource physicalDataSource = mock(DataSource.class);
        Connection physicalConnection = mock(Connection.class);
        when(physicalConnection.isValid(Mockito.anyInt())).thenReturn(true);
        when(physicalDataSource.getConnection()).thenReturn(physicalConnection);

        try (HikariDataSource pool = new HikariDataSource()) {
            pool.setDataSource(physicalDataSource);
            pool.setMaximumPoolSize(1);
            pool.setMinimumIdle(0);
            pool.setConnectionTimeout(500L);
            pool.setValidationTimeout(250L);
            coordinator = new DatabaseMigrationCoordinator(
                pool, mock(Flyway.class), Duration.ofSeconds(1));

            coordinator.refresh();
            assertThat(coordinator.health().getStatus().getCode()).isEqualTo("UP");

            HikariPoolMXBean poolMetrics = pool.getHikariPoolMXBean();
            try (Connection heldConnection = pool.getConnection()) {
                assertThat(poolMetrics.getActiveConnections()).isEqualTo(1);
                assertThat(poolMetrics.getIdleConnections()).isZero();
                assertThat(poolMetrics.getTotalConnections()).isEqualTo(1);

                ExecutorService healthExecutor = Executors.newSingleThreadExecutor();
                Future<Health> health = null;
                try {
                    health = healthExecutor.submit(coordinator::health);

                    long waiterDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                    awaitConnectionWaiter(poolMetrics, health, waiterDeadline);

                    long completionDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                    Health result = health.get(
                        remainingNanos(completionDeadline), TimeUnit.NANOSECONDS);

                    assertThat(result.getStatus().getCode()).isEqualTo("DOWN");
                    long resetDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
                    awaitNoConnectionWaiters(poolMetrics, resetDeadline);
                } finally {
                    if (health != null && !health.isDone()) {
                        health.cancel(true);
                    }
                    healthExecutor.shutdownNow();
                    assertThat(healthExecutor.awaitTermination(1, TimeUnit.SECONDS))
                        .as("health executor terminated")
                        .isTrue();
                }
            }
        }
    }

    @Test
    void readyStateDoesNotScheduleMoreMigrations() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection()).thenReturn(mock(Connection.class));
        Flyway flyway = mock(Flyway.class);
        CountDownLatch migrated = new CountDownLatch(1);
        doAnswer(invocation -> {
            migrated.countDown();
            return null;
        }).when(flyway).migrate();
        coordinator = new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofSeconds(1));

        coordinator.start();

        assertThat(migrated.await(1, TimeUnit.SECONDS)).isTrue();
        Thread.sleep(1_100L);
        coordinator.health();
        verify(flyway, times(1)).migrate();
    }

    @Test
    void logsStartupDatabaseUnavailabilityOnceWithoutExceptionDetails(CapturedOutput output)
            throws Exception {
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection())
            .thenThrow(new SQLException("jdbc:postgresql://private-host/trips?password=secret"));
        coordinator = new DatabaseMigrationCoordinator(
            dataSource, mock(Flyway.class), Duration.ofSeconds(1));

        coordinator.refresh();
        coordinator.refresh();

        assertThat(occurrences(output.getAll(), "event=startup_db_unavailable")).isEqualTo(1);
        assertThat(output.getAll())
            .contains("retry_delay_ms=1000 exception_type=SQLException")
            .doesNotContain("private-host", "password=secret");
    }

    @Test
    void logsMigrationFailureOnceAndRecoveryWithoutExceptionDetails(CapturedOutput output)
            throws Exception {
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection()).thenReturn(mock(Connection.class));
        Flyway flyway = mock(Flyway.class);
        when(flyway.migrate())
            .thenThrow(new org.flywaydb.core.api.FlywayException("migration SQL contained a secret"))
            .thenThrow(new org.flywaydb.core.api.FlywayException("another private detail"))
            .thenReturn(null);
        coordinator = new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofSeconds(1));

        coordinator.refresh();
        coordinator.refresh();
        coordinator.refresh();

        assertThat(occurrences(output.getAll(), "event=migration_failed")).isEqualTo(1);
        assertThat(occurrences(output.getAll(), "event=recovered")).isEqualTo(1);
        assertThat(output.getAll())
            .contains("retry_delay_ms=1000 exception_type=FlywayException")
            .doesNotContain("migration SQL contained a secret", "another private detail");
    }

    @Test
    void classifiesHealthyConnectionLossAsTransitionAndLogsRecovery(CapturedOutput output)
            throws Exception {
        DataSource dataSource = mock(DataSource.class);
        Connection connection = mock(Connection.class);
        when(dataSource.getConnection())
            .thenReturn(connection)
            .thenThrow(new SQLException("private JDBC detail"))
            .thenReturn(connection);
        coordinator = new DatabaseMigrationCoordinator(
            dataSource, mock(Flyway.class), Duration.ofSeconds(1));

        coordinator.refresh();
        coordinator.health();
        coordinator.health();
        coordinator.refresh();

        assertThat(occurrences(output.getAll(), "event=healthy_to_down")).isEqualTo(1);
        assertThat(occurrences(output.getAll(), "event=startup_db_unavailable")).isZero();
        assertThat(occurrences(output.getAll(), "event=recovered")).isEqualTo(1);
        assertThat(output.getAll())
            .contains("retry_delay_ms=1000 exception_type=SQLException")
            .doesNotContain("private JDBC detail");
    }

    @Test
    void logsListenerFailureTypeWithoutListenerExceptionDetails(CapturedOutput output)
            throws Exception {
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection()).thenReturn(mock(Connection.class));
        ApplicationEventPublisher events = event -> {
            throw new IllegalStateException("listener included a secret");
        };
        coordinator = new DatabaseMigrationCoordinator(
            dataSource, mock(Flyway.class), events, Duration.ofSeconds(1));

        coordinator.refresh();

        assertThat(output.getAll())
            .contains("event=listener_failed exception_type=IllegalStateException")
            .doesNotContain("listener included a secret");
    }

    @Test
    void logsLifecycleTransitionsOnlyWhenStateChanges(CapturedOutput output) throws Exception {
        DataSource dataSource = mock(DataSource.class);
        when(dataSource.getConnection()).thenReturn(mock(Connection.class));
        coordinator = new DatabaseMigrationCoordinator(
            dataSource, mock(Flyway.class), Duration.ofSeconds(1));

        coordinator.start();
        coordinator.start();
        coordinator.stop();
        coordinator.stop();

        assertThat(occurrences(output.getAll(), "event=coordinator_started")).isEqualTo(1);
        assertThat(occurrences(output.getAll(), "event=coordinator_stopping")).isEqualTo(1);
        assertThat(output.getAll()).contains("retry_delay_ms=1000");
    }

    private static int occurrences(String text, String value) {
        return (text.length() - text.replace(value, "").length()) / value.length();
    }

    private static void awaitOutputContains(CapturedOutput output, String value)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (!output.getAll().contains(value) && System.nanoTime() < deadline) {
            Thread.sleep(10L);
        }
        assertThat(output.getAll()).contains(value);
    }

    private static void awaitConnectionWaiter(HikariPoolMXBean poolMetrics,
                                              Future<?> health,
                                              long deadline) throws InterruptedException {
        while (poolMetrics.getThreadsAwaitingConnection() != 1 && System.nanoTime() < deadline) {
            assertThat(health).as("health check completed before waiting for a pooled connection")
                .isNotDone();
            Thread.sleep(5L);
        }
        assertThat(poolMetrics.getThreadsAwaitingConnection()).isEqualTo(1);
    }

    private static void awaitNoConnectionWaiters(HikariPoolMXBean poolMetrics, long deadline)
            throws InterruptedException {
        while (poolMetrics.getThreadsAwaitingConnection() != 0 && System.nanoTime() < deadline) {
            Thread.sleep(5L);
        }
        assertThat(poolMetrics.getThreadsAwaitingConnection()).isZero();
    }

    private static long remainingNanos(long deadline) {
        return Math.max(1L, deadline - System.nanoTime());
    }
}
