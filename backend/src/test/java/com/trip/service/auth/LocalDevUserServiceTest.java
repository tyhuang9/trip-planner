package com.trip.service.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.context.event.EventListener;

import com.trip.config.DatabaseReadyEvent;
import com.trip.domain.User;
import com.trip.repo.UserRepository;
import com.trip.web.exception.ValidationException;

@ExtendWith(MockitoExtension.class)
class LocalDevUserServiceTest {

    private static final OffsetDateTime NOW =
        OffsetDateTime.ofInstant(Instant.parse("2026-07-07T12:00:00Z"), ZoneOffset.UTC);

    @Mock
    UserRepository userRepository;

    @Mock
    PasswordEncoder passwordEncoder;

    LocalDevUserService service;

    @BeforeEach
    void setUp() {
        service = new LocalDevUserService(
            userRepository,
            passwordEncoder,
            Clock.fixed(NOW.toInstant(), ZoneOffset.UTC));
    }

    @Test
    void createFakeUserRequiresTestLocalAndCreatesVerifiedUserWithDefaultPassword() {
        when(userRepository.existsByEmailIgnoreCase("david@test.local")).thenReturn(false);
        when(passwordEncoder.encode(LocalDevUserService.DEFAULT_PASSWORD)).thenReturn("hashed-password");
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> {
            User user = invocation.getArgument(0);
            setId(user, 99L);
            return user;
        });

        var summary = service.createFakeUser("  DAVID@Test.Local  ", " David Kim ");

        assertThat(summary.id()).isEqualTo(99L);
        assertThat(summary.email()).isEqualTo("david@test.local");
        assertThat(summary.displayName()).isEqualTo("David Kim");
        assertThat(summary.emailVerified()).isTrue();

        ArgumentCaptor<User> userCaptor = ArgumentCaptor.forClass(User.class);
        verify(userRepository).save(userCaptor.capture());
        User saved = userCaptor.getValue();
        assertThat(saved.getPasswordHash()).isEqualTo("hashed-password");
        assertThat(saved.getEmailVerifiedAt()).isEqualTo(NOW);
    }

    @Test
    void createFakeUserRejectsNonTestLocalEmail() {
        assertThatThrownBy(() -> service.createFakeUser("david@example.com", "David"))
            .isInstanceOfSatisfying(ValidationException.class,
                ex -> assertThat(ex.slug()).isEqualTo("invalid_dev_user"));

        verify(userRepository, never()).save(any());
    }

    @Test
    void seedDefaultsCreatesKnownUsersIdempotently() {
        AtomicLong ids = new AtomicLong(1L);
        when(passwordEncoder.encode(LocalDevUserService.DEFAULT_PASSWORD)).thenReturn("hashed-password");
        when(userRepository.findByEmailIgnoreCase("alice@test.local")).thenReturn(Optional.empty());
        when(userRepository.findByEmailIgnoreCase("bob@test.local")).thenReturn(Optional.empty());
        when(userRepository.findByEmailIgnoreCase("charlie@test.local")).thenReturn(Optional.empty());
        User existingAdmin = userWith(44L, "admin@test.local", "Old Admin");
        existingAdmin.markEmailVerified(NOW.minusDays(1));
        when(userRepository.findByEmailIgnoreCase("admin@test.local"))
            .thenReturn(Optional.of(existingAdmin));
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> {
            User user = invocation.getArgument(0);
            if (user.getId() == null) {
                setId(user, ids.getAndIncrement());
            }
            return user;
        });
        when(userRepository.findByEmailEndingWithIgnoreCaseOrderByEmail("@test.local"))
            .thenReturn(List.of(existingAdmin));

        service.seedDefaults();

        ArgumentCaptor<User> userCaptor = ArgumentCaptor.forClass(User.class);
        verify(userRepository, org.mockito.Mockito.times(4)).save(userCaptor.capture());
        assertThat(userCaptor.getAllValues())
            .extracting(User::getEmail)
            .containsExactly(
                "alice@test.local",
                "bob@test.local",
                "charlie@test.local",
                "admin@test.local");
        assertThat(existingAdmin.getDisplayName()).isEqualTo("Admin User");
        assertThat(existingAdmin.isEmailVerified()).isTrue();
    }

    @Test
    void readyEventSeedsDefaultsOnceWithoutReturningAnEventPayload() throws Exception {
        when(passwordEncoder.encode(LocalDevUserService.DEFAULT_PASSWORD)).thenReturn("hashed-password");
        when(userRepository.findByEmailIgnoreCase(any())).thenReturn(Optional.empty());
        when(userRepository.findByEmailEndingWithIgnoreCaseOrderByEmail("@test.local")).thenReturn(List.of());

        service.seedWhenDatabaseReady(new DatabaseReadyEvent(this));

        verify(userRepository, org.mockito.Mockito.times(4)).save(any(User.class));
        var listener = LocalDevUserService.class.getMethod(
            "seedWhenDatabaseReady", DatabaseReadyEvent.class);
        assertThat(listener.getReturnType()).isEqualTo(void.class);
        assertThat(listener.isAnnotationPresent(EventListener.class)).isTrue();
    }

    private static User userWith(long id, String email, String displayName) {
        User user = new User(email, "ignored-hash", displayName);
        setId(user, id);
        return user;
    }

    private static void setId(User user, long id) {
        try {
            var field = User.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(user, id);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }
}
