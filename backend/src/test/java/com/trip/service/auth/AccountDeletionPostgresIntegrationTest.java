package com.trip.service.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase.Replace.NONE;

import java.time.Duration;
import java.time.LocalDate;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.domain.User;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.AccountService.DeleteAccountResult;
import com.trip.service.auth.RefreshTokenService.IssuedRefreshToken;

@DataJpaTest(properties = {
    "spring.flyway.enabled=true",
    "spring.jpa.hibernate.ddl-auto=validate",
    "spring.datasource.hikari.maximum-pool-size=5",
    "spring.datasource.hikari.minimum-idle=0"
})
@AutoConfigureTestDatabase(replace = NONE)
@Import({AccountService.class, RefreshTokenService.class,
    AccountDeletionPostgresIntegrationTest.PasswordConfig.class})
@Testcontainers(disabledWithoutDocker = true)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class AccountDeletionPostgresIntegrationTest {

    private static final String PASSWORD = "correct horse battery staple";

    @Container
    static final PostgreSQLContainer<?> POSTGRES =
        new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void postgresProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
    }

    @Autowired
    AccountService accountService;

    @Autowired
    RefreshTokenService refreshTokenService;

    @Autowired
    UserRepository userRepository;

    @Autowired
    TripRepository tripRepository;

    @Autowired
    TripMemberRepository tripMemberRepository;

    @Autowired
    RefreshTokenRepository refreshTokenRepository;

    @Autowired
    PasswordEncoder passwordEncoder;

    @Autowired
    JdbcTemplate jdbcTemplate;

    @Autowired
    PlatformTransactionManager transactionManager;

    TransactionTemplate transactions;

    @BeforeEach
    void resetDatabase() {
        transactions = new TransactionTemplate(transactionManager);
        jdbcTemplate.execute("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
    }

    @Test
    void deletingAccountRemovesPrivateTripMembershipAndRefreshTokens() {
        User owner = saveUser("private-owner@example.com");
        Trip trip = saveTrip(owner, "private-trip");
        tripMemberRepository.save(new TripMember(trip.getId(), owner.getId(), TripRole.OWNER));
        IssuedRefreshToken refresh = refreshTokenService.issueFor(owner);

        assertThat(accountService.deleteAccount(owner.getId(), PASSWORD))
            .isEqualTo(DeleteAccountResult.DELETED);

        assertThat(userRepository.findById(owner.getId())).isEmpty();
        assertThat(tripRepository.findById(trip.getId())).isEmpty();
        assertThat(tripMemberRepository.count()).isZero();
        assertThat(refreshTokenRepository.count()).isZero();
        assertThat(refreshTokenService.validate(refresh.rawToken())).isEmpty();
    }

    @Test
    void deletingSharedTripOwnerTransfersOwnershipAndPreservesRemainingMembers() {
        User owner = saveUser("shared-owner@example.com");
        User viewer = saveUser("shared-viewer@example.com");
        User editor = saveUser("shared-editor@example.com");
        Trip trip = saveTrip(owner, "shared-trip");
        tripMemberRepository.save(new TripMember(trip.getId(), owner.getId(), TripRole.OWNER));
        tripMemberRepository.save(new TripMember(trip.getId(), viewer.getId(), TripRole.VIEWER));
        tripMemberRepository.save(new TripMember(trip.getId(), editor.getId(), TripRole.EDITOR));

        assertThat(accountService.deleteAccount(owner.getId(), PASSWORD))
            .isEqualTo(DeleteAccountResult.DELETED);

        Trip transferred = tripRepository.findById(trip.getId()).orElseThrow();
        assertThat(transferred.getOwnerId()).isEqualTo(editor.getId());
        assertThat(tripMemberRepository.findByIdTripIdAndIdUserId(trip.getId(), owner.getId()))
            .isEmpty();
        assertThat(tripMemberRepository.findByIdTripIdAndIdUserId(trip.getId(), editor.getId()))
            .get().extracting(TripMember::getRole).isEqualTo(TripRole.OWNER);
        assertThat(tripMemberRepository.findByIdTripIdAndIdUserId(trip.getId(), viewer.getId()))
            .get().extracting(TripMember::getRole).isEqualTo(TripRole.VIEWER);
        assertThat(tripMemberRepository.findAllByIdTripIdOrderByCreatedAtAsc(trip.getId()))
            .hasSize(2);
    }

    @Test
    void restrictedOwnerForeignKeyRollsBackDirectUserDeletion() {
        User owner = saveUser("restricted-owner@example.com");
        Trip trip = saveTrip(owner, "restricted-trip");
        tripMemberRepository.save(new TripMember(trip.getId(), owner.getId(), TripRole.OWNER));

        assertThatThrownBy(() -> transactions.executeWithoutResult(status ->
            jdbcTemplate.update("DELETE FROM users WHERE id = ?", owner.getId())))
            .isInstanceOf(DataIntegrityViolationException.class);

        assertThat(userRepository.findById(owner.getId())).isPresent();
        assertThat(tripRepository.findById(trip.getId())).isPresent();
        assertThat(tripMemberRepository.findByIdTripIdAndIdUserId(trip.getId(), owner.getId()))
            .isPresent();
    }

    @Test
    void refreshRotationWaitsForDeletionUserLockAndCannotOutliveDeletion() throws Exception {
        User user = saveUser("concurrent-owner@example.com");
        IssuedRefreshToken refresh = refreshTokenService.issueFor(user);
        CountDownLatch deletionHasLock = new CountDownLatch(1);
        CountDownLatch allowDeletion = new CountDownLatch(1);
        CountDownLatch rotationStarted = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);

        try {
            Future<DeleteAccountResult> deletion = executor.submit(() ->
                transactions.execute(status -> {
                    setApplicationName("account-delete-holder");
                    userRepository.findByIdForUpdate(user.getId()).orElseThrow();
                    deletionHasLock.countDown();
                    awaitLatch(allowDeletion);
                    return accountService.deleteAccount(user.getId(), PASSWORD);
                }));
            assertThat(deletionHasLock.await(5, TimeUnit.SECONDS)).isTrue();

            Future<Optional<IssuedRefreshToken>> rotation = executor.submit(() ->
                transactions.execute(status -> {
                    setApplicationName("refresh-rotation-waiter");
                    rotationStarted.countDown();
                    return refreshTokenService.rotate(refresh.rawToken());
                }));
            assertThat(rotationStarted.await(5, TimeUnit.SECONDS)).isTrue();
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(isWaitingOnDatabaseLock("refresh-rotation-waiter")).isTrue());

            allowDeletion.countDown();

            assertThat(deletion.get(5, TimeUnit.SECONDS)).isEqualTo(DeleteAccountResult.DELETED);
            assertThat(rotation.get(5, TimeUnit.SECONDS)).isEmpty();
            assertThat(userRepository.findById(user.getId())).isEmpty();
            assertThat(refreshTokenRepository.count()).isZero();
        } finally {
            allowDeletion.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    private User saveUser(String email) {
        return userRepository.save(new User(email, passwordEncoder.encode(PASSWORD), email));
    }

    private Trip saveTrip(User owner, String name) {
        String publicId = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        return tripRepository.save(new Trip(publicId, owner.getId(), name, "Chicago",
            LocalDate.of(2026, 8, 1), LocalDate.of(2026, 8, 3)));
    }

    private void setApplicationName(String name) {
        jdbcTemplate.queryForObject(
            "SELECT set_config('application_name', ?, true)", String.class, name);
    }

    private boolean isWaitingOnDatabaseLock(String applicationName) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject("""
            SELECT EXISTS (
                SELECT 1
                FROM pg_stat_activity
                WHERE application_name = ?
                  AND wait_event_type = 'Lock'
            )
            """, Boolean.class, applicationName));
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("Timed out waiting for concurrent test step");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while waiting for concurrent test step",
                interrupted);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class PasswordConfig {

        @Bean
        PasswordEncoder passwordEncoder() {
            return new BCryptPasswordEncoder(4);
        }
    }
}
