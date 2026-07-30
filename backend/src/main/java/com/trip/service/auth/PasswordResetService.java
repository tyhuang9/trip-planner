package com.trip.service.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.trip.domain.PasswordResetToken;
import com.trip.domain.User;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.AuthEmailSender.PasswordResetEmail;
import com.trip.web.exception.ValidationException;

@Service
public class PasswordResetService {

    static final Duration RESET_TOKEN_TTL = Duration.ofHours(1);
    static final int TOKEN_GENERATION_ATTEMPTS = 5;

    private static final Logger log = LoggerFactory.getLogger(PasswordResetService.class);
    private static final int RAW_TOKEN_BYTES = 32;

    private final PasswordResetTokenRepository passwordResetTokenRepository;
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final RefreshTokenService refreshTokenService;
    private final AuthEmailSender emailSender;
    private final SecureRandom random;
    private final AuthEmailTransactionRunner transactionRunner;

    @Autowired
    public PasswordResetService(PasswordResetTokenRepository passwordResetTokenRepository,
                                UserRepository userRepository,
                                PasswordEncoder passwordEncoder,
                                RefreshTokenService refreshTokenService,
                                AuthEmailSender emailSender,
                                AuthEmailTransactionRunner transactionRunner) {
        this(passwordResetTokenRepository, userRepository, passwordEncoder, refreshTokenService,
            emailSender, new SecureRandom(), transactionRunner);
    }

    PasswordResetService(PasswordResetTokenRepository passwordResetTokenRepository,
                         UserRepository userRepository,
                         PasswordEncoder passwordEncoder,
                         RefreshTokenService refreshTokenService,
                         AuthEmailSender emailSender,
                         SecureRandom random) {
        this(passwordResetTokenRepository, userRepository, passwordEncoder, refreshTokenService,
            emailSender, random, new AuthEmailTransactionRunner());
    }

    PasswordResetService(PasswordResetTokenRepository passwordResetTokenRepository,
                         UserRepository userRepository,
                         PasswordEncoder passwordEncoder,
                         RefreshTokenService refreshTokenService,
                         AuthEmailSender emailSender,
                         SecureRandom random,
                         AuthEmailTransactionRunner transactionRunner) {
        this.passwordResetTokenRepository = passwordResetTokenRepository;
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.refreshTokenService = refreshTokenService;
        this.emailSender = emailSender;
        this.random = random;
        this.transactionRunner = transactionRunner;
    }

    public void requestReset(String email) {
        String normalizedEmail = EmailNormalizer.normalize(email);
        String recipientDomain = emailDomain(normalizedEmail);
        log.info("Password reset request received recipientDomain={}", recipientDomain);
        PreparedPasswordReset prepared = transactionRunner.inNewTransaction(
            status -> createResetToken(normalizedEmail, recipientDomain));
        if (prepared == null) {
            return;
        }

        boolean revoked = false;
        try {
            transactionRunner.outsideTransaction(status -> {
                emailSender.sendPasswordReset(prepared.email());
                return null;
            });
            log.info("Password reset email send completed userId={} recipientDomain={} expiresAt={} token=<redacted>",
                prepared.userId(), recipientDomain, prepared.email().expiresAt());
        } catch (RuntimeException e) {
            if (isExplicitProviderRejection(e)) {
                transactionRunner.inNewTransaction(status -> {
                    prepared.token().revoke(OffsetDateTime.now());
                    passwordResetTokenRepository.save(prepared.token());
                    return null;
                });
                revoked = true;
            }
            logEmailFailure(prepared.userId(), recipientDomain, e, revoked);
        }
    }

    private PreparedPasswordReset createResetToken(String normalizedEmail, String recipientDomain) {
        // Account deletion uses this same user → token row order before cascading deletes.
        Optional<User> maybeUser = userRepository.findByEmailIgnoreCase(normalizedEmail)
            .flatMap(user -> userRepository.findByIdForUpdate(user.getId()));
        if (maybeUser.isEmpty()) {
            log.info("Password reset request completed without email recipientDomain={} matched=false",
                recipientDomain);
            return null;
        }

        User user = maybeUser.get();
        OffsetDateTime now = OffsetDateTime.now();
        passwordResetTokenRepository.revokeActiveForUser(user.getId(), now);
        GeneratedToken generated = generateUniqueToken();
        PasswordResetToken saved = passwordResetTokenRepository.save(new PasswordResetToken(
            user.getId(), generated.hash(), now.plus(RESET_TOKEN_TTL)));
        log.info(
            "Password reset token created userId={} recipientDomain={} expiresAt={} token=<redacted>",
            user.getId(), recipientDomain, saved.getExpiresAt());
        return new PreparedPasswordReset(
            user.getId(),
            saved,
            new PasswordResetEmail(user.getEmail(), generated.raw(), saved.getExpiresAt()));
    }

    private void logEmailFailure(long userId,
                                 String recipientDomain,
                                 RuntimeException exception,
                                 boolean revoked) {
        if (exception instanceof AuthEmailDeliveryException delivery) {
            log.warn(
                "Password reset email sender failed for userId={} recipientDomain={} provider={} operation={} status={} providerBody={} tokenRevoked={} token=<redacted>",
                userId,
                recipientDomain,
                delivery.provider(),
                delivery.operation(),
                delivery.statusCode(),
                delivery.providerResponseBody(),
                revoked);
            return;
        }
        log.warn(
            "Password reset email sender failed for userId={} recipientDomain={} exception={} tokenRevoked={} token=<redacted>",
            userId, recipientDomain, exception.getClass().getSimpleName(), revoked);
    }

    private static boolean isExplicitProviderRejection(RuntimeException exception) {
        return exception instanceof AuthEmailDeliveryException delivery
            && delivery.isExplicitProviderRejection();
    }

    @Transactional
    public void confirmReset(String rawToken, String password) {
        String hash = sha256Hex(rawToken);
        PasswordResetToken observedToken = passwordResetTokenRepository.findByTokenHash(hash)
            .orElseThrow(PasswordResetService::invalidToken);
        if (!observedToken.isUsableAt(OffsetDateTime.now())) {
            throw invalidToken();
        }

        String passwordHash = passwordEncoder.encode(password);
        User user = userRepository.findByIdForUpdate(observedToken.getUserId())
            .orElseThrow(PasswordResetService::invalidToken);
        PasswordResetToken resetToken = passwordResetTokenRepository.findByTokenHashForUpdate(hash)
            .filter(token -> token.getUserId().equals(user.getId()))
            .orElseThrow(PasswordResetService::invalidToken);
        OffsetDateTime now = OffsetDateTime.now();
        if (!resetToken.isUsableAt(now)) {
            throw invalidToken();
        }

        user.setPasswordHash(passwordHash);
        userRepository.save(user);
        refreshTokenService.revokeAllForUser(user.getId());
        resetToken.consume(now);
        passwordResetTokenRepository.save(resetToken);
    }

    private GeneratedToken generateUniqueToken() {
        for (int attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt++) {
            String raw = generateRawToken();
            String hash = sha256Hex(raw);
            if (passwordResetTokenRepository.findByTokenHash(hash).isEmpty()) {
                return new GeneratedToken(raw, hash);
            }
        }
        throw new IllegalStateException("exhausted password reset token generation retries");
    }

    private String generateRawToken() {
        byte[] raw = new byte[RAW_TOKEN_BYTES];
        random.nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hashed);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 digest unavailable", e);
        }
    }

    private static ValidationException invalidToken() {
        return new ValidationException("invalid_reset_token", "password reset token is invalid");
    }

    private static String emailDomain(String email) {
        if (email == null || email.isBlank()) {
            return "<missing>";
        }
        int at = email.lastIndexOf('@');
        if (at < 0 || at == email.length() - 1) {
            return "<invalid>";
        }
        return email.substring(at + 1).toLowerCase(Locale.ROOT);
    }

    private record GeneratedToken(String raw, String hash) {
    }

    private record PreparedPasswordReset(long userId,
                                         PasswordResetToken token,
                                         PasswordResetEmail email) {
    }
}
