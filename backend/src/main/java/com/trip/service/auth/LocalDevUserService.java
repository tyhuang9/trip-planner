package com.trip.service.auth;

import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.trip.domain.User;
import com.trip.config.DatabaseReadyEvent;
import com.trip.repo.UserRepository;
import com.trip.web.auth.DisplayNameSanitizer;
import com.trip.web.dto.UserSummary;
import com.trip.web.exception.NotFoundException;
import com.trip.web.exception.ValidationException;

@Service
@Profile("local")
public class LocalDevUserService {

    public static final String TEST_EMAIL_SUFFIX = "@test.local";
    public static final String DEFAULT_PASSWORD = "password";

    private static final List<SeedUser> DEFAULT_USERS = List.of(
        new SeedUser("alice@test.local", "Alice Chen"),
        new SeedUser("bob@test.local", "Bob Martinez"),
        new SeedUser("charlie@test.local", "Charlie Patel"),
        new SeedUser("admin@test.local", "Admin User")
    );

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final Clock clock;

    @Autowired
    public LocalDevUserService(UserRepository userRepository, PasswordEncoder passwordEncoder) {
        this(userRepository, passwordEncoder, Clock.systemUTC());
    }

    LocalDevUserService(UserRepository userRepository, PasswordEncoder passwordEncoder, Clock clock) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<UserSummary> listTestUsers() {
        return userRepository.findByEmailEndingWithIgnoreCaseOrderByEmail(TEST_EMAIL_SUFFIX)
            .stream()
            .map(UserSummary::from)
            .toList();
    }

    @Transactional
    public List<UserSummary> seedDefaults() {
        for (SeedUser seed : DEFAULT_USERS) {
            upsertSeedUser(seed);
        }
        return listTestUsers();
    }

    @EventListener(DatabaseReadyEvent.class)
    @Transactional
    public void seedWhenDatabaseReady(DatabaseReadyEvent ignored) {
        seedDefaults();
    }

    @Transactional
    public UserSummary createFakeUser(String email, String name) {
        String normalizedEmail = EmailNormalizer.normalize(email);
        assertTestLocalEmail(normalizedEmail);
        String displayName = sanitizeName(name);
        if (userRepository.existsByEmailIgnoreCase(normalizedEmail)) {
            throw new ValidationException("email_taken", "dev user already exists");
        }

        User user = new User(normalizedEmail, passwordEncoder.encode(DEFAULT_PASSWORD), displayName);
        user.markEmailVerified(now());
        return UserSummary.from(userRepository.save(user));
    }

    @Transactional(readOnly = true)
    public User requireTestUser(String email) {
        String normalizedEmail = EmailNormalizer.normalize(email);
        assertTestLocalEmail(normalizedEmail);
        return userRepository.findByEmailIgnoreCase(normalizedEmail)
            .orElseThrow(() -> new NotFoundException("dev user not found"));
    }

    @Transactional
    public void deleteTestUser(String email) {
        User user = requireTestUser(email);
        userRepository.delete(user);
    }

    private void upsertSeedUser(SeedUser seed) {
        String normalizedEmail = EmailNormalizer.normalize(seed.email());
        User user = userRepository.findByEmailIgnoreCase(normalizedEmail)
            .orElseGet(() -> new User(normalizedEmail, passwordEncoder.encode(DEFAULT_PASSWORD), seed.name()));
        user.setDisplayName(seed.name());
        user.setPasswordHash(passwordEncoder.encode(DEFAULT_PASSWORD));
        if (!user.isEmailVerified()) {
            user.markEmailVerified(now());
        }
        userRepository.save(user);
    }

    private static void assertTestLocalEmail(String normalizedEmail) {
        if (!normalizedEmail.endsWith(TEST_EMAIL_SUFFIX)) {
            throw new ValidationException("invalid_dev_user", "dev users must use @test.local emails");
        }
    }

    private static String sanitizeName(String name) {
        String sanitized = DisplayNameSanitizer.sanitize(name);
        if (sanitized == null || sanitized.isBlank()) {
            throw new ValidationException("invalid_display_name", "displayName cannot be blank");
        }
        return sanitized;
    }

    private OffsetDateTime now() {
        return OffsetDateTime.now(clock);
    }

    private record SeedUser(String email, String name) {
    }
}
