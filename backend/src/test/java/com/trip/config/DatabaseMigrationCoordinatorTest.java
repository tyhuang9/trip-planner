package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.sql.DataSource;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

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
            .thenThrow(new SQLException("unavailable"))
            .thenReturn(connection);
        Flyway flyway = mock(Flyway.class);
        coordinator = new DatabaseMigrationCoordinator(dataSource, flyway, Duration.ofSeconds(1));

        coordinator.refresh();
        assertThat(coordinator.health().getStatus().getCode()).isEqualTo("UP");

        coordinator.refresh();
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
    void startsWithoutWaitingForABlockedDatabaseCheck() throws Exception {
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
    }
}
