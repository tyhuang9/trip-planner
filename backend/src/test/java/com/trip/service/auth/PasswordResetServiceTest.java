package com.trip.service.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionOperations;

import com.trip.domain.PasswordResetToken;
import com.trip.domain.User;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.AuthEmailSender.PasswordResetEmail;
import com.trip.web.exception.ValidationException;

@ExtendWith(MockitoExtension.class)
class PasswordResetServiceTest {

    private static final String RAW_TOKEN = "abcdefghijklmnopqrstuvwxyz1234567890";

    @Mock
    PasswordResetTokenRepository passwordResetTokenRepository;

    @Mock
    UserRepository userRepository;

    @Mock
    PasswordEncoder passwordEncoder;

    @Mock
    RefreshTokenService refreshTokenService;

    @Mock
    AuthEmailSender emailSender;

    PasswordResetService service;

    @BeforeEach
    void setUp() {
        service = new PasswordResetService(
            passwordResetTokenRepository,
            userRepository,
            passwordEncoder,
            refreshTokenService,
            emailSender,
            new SecureRandom(new byte[] { 1, 2, 3, 4 }));
    }

    @Test
    void requestResetNormalizesEmailPersistsOnlyHashAndSendsRawTokenToSender() {
        User user = userWith(42L, "alice@example.com", "Alice");
        when(userRepository.findByEmailIgnoreCase("alice@example.com"))
            .thenReturn(Optional.of(user));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordResetTokenRepository.findByTokenHash(anyString())).thenReturn(Optional.empty());
        when(passwordResetTokenRepository.save(any(PasswordResetToken.class)))
            .thenAnswer(invocation -> invocation.getArgument(0));

        service.requestReset("  ALICE@Example.com  ");

        ArgumentCaptor<PasswordResetToken> tokenCaptor =
            ArgumentCaptor.forClass(PasswordResetToken.class);
        verify(passwordResetTokenRepository).save(tokenCaptor.capture());
        PasswordResetToken saved = tokenCaptor.getValue();
        assertThat(saved.getUserId()).isEqualTo(42L);
        assertThat(saved.getTokenHash()).hasSize(64);

        ArgumentCaptor<PasswordResetEmail> emailCaptor =
            ArgumentCaptor.forClass(PasswordResetEmail.class);
        verify(emailSender).sendPasswordReset(emailCaptor.capture());
        PasswordResetEmail email = emailCaptor.getValue();
        assertThat(email.recipientEmail()).isEqualTo("alice@example.com");
        assertThat(email.token()).isNotBlank();
        assertThat(saved.getTokenHash()).isEqualTo(sha256Hex(email.token()));
        assertThat(saved.getTokenHash()).doesNotContain(email.token());
        assertThat(email.toString()).doesNotContain(email.token());
        verify(passwordResetTokenRepository).revokeActiveForUser(any(), any());
        InOrder lockOrder = inOrder(userRepository, passwordResetTokenRepository);
        lockOrder.verify(userRepository).findByIdForUpdate(42L);
        lockOrder.verify(passwordResetTokenRepository).revokeActiveForUser(any(), any());
    }

    @Test
    void requestResetForMissingUserDoesNotCreateToken() {
        when(userRepository.findByEmailIgnoreCase("missing@example.com"))
            .thenReturn(Optional.empty());

        service.requestReset("missing@example.com");

        verify(passwordResetTokenRepository, never()).save(any());
        verify(passwordResetTokenRepository, never()).revokeActiveForUser(any(), any());
        verify(emailSender, never()).sendPasswordReset(any());
    }

    @Test
    void requestResetRevokesSavedTokenWhenEmailDeliveryFails() {
        User user = userWith(42L, "alice@example.com", "Alice");
        when(userRepository.findByEmailIgnoreCase("alice@example.com"))
            .thenReturn(Optional.of(user));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordResetTokenRepository.findByTokenHash(anyString())).thenReturn(Optional.empty());
        when(passwordResetTokenRepository.save(any(PasswordResetToken.class)))
            .thenAnswer(invocation -> invocation.getArgument(0));
        doThrow(AuthEmailDeliveryException.brevoStatus(
            "password_reset", 401, "{\"message\":\"token=raw-token\"}"))
            .when(emailSender)
            .sendPasswordReset(any());

        service.requestReset("alice@example.com");

        ArgumentCaptor<PasswordResetToken> tokenCaptor =
            ArgumentCaptor.forClass(PasswordResetToken.class);
        verify(passwordResetTokenRepository, times(2)).save(tokenCaptor.capture());
        PasswordResetToken revoked = tokenCaptor.getAllValues().get(1);
        assertThat(revoked.getRevokedAt()).isNotNull();
        assertThat(revoked.isUsableAt(OffsetDateTime.now())).isFalse();
        verify(passwordResetTokenRepository).revokeActiveForUser(any(), any());
    }

    @Test
    void requestResetKeepsTokenUsableWhenProviderFailureIsAmbiguous() {
        User user = userWith(42L, "alice@example.com", "Alice");
        when(userRepository.findByEmailIgnoreCase("alice@example.com"))
            .thenReturn(Optional.of(user));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordResetTokenRepository.findByTokenHash(anyString())).thenReturn(Optional.empty());
        when(passwordResetTokenRepository.save(any(PasswordResetToken.class)))
            .thenAnswer(invocation -> invocation.getArgument(0));
        doThrow(AuthEmailDeliveryException.brevoStatus(
            "password_reset", 503, "provider unavailable"))
            .when(emailSender)
            .sendPasswordReset(any());

        service.requestReset("alice@example.com");

        ArgumentCaptor<PasswordResetToken> tokenCaptor =
            ArgumentCaptor.forClass(PasswordResetToken.class);
        verify(passwordResetTokenRepository).save(tokenCaptor.capture());
        assertThat(tokenCaptor.getValue().getRevokedAt()).isNull();
    }

    @Test
    void requestResetKeepsTokenUsableWhenProviderTimesOut() {
        User user = userWith(42L, "alice@example.com", "Alice");
        when(userRepository.findByEmailIgnoreCase("alice@example.com"))
            .thenReturn(Optional.of(user));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordResetTokenRepository.findByTokenHash(anyString())).thenReturn(Optional.empty());
        when(passwordResetTokenRepository.save(any(PasswordResetToken.class)))
            .thenAnswer(invocation -> invocation.getArgument(0));
        doThrow(AuthEmailDeliveryException.brevoIo(
            "password_reset", new java.net.http.HttpTimeoutException("provider timeout")))
            .when(emailSender)
            .sendPasswordReset(any());

        service.requestReset("alice@example.com");

        ArgumentCaptor<PasswordResetToken> tokenCaptor =
            ArgumentCaptor.forClass(PasswordResetToken.class);
        verify(passwordResetTokenRepository).save(tokenCaptor.capture());
        assertThat(tokenCaptor.getValue().getRevokedAt()).isNull();
    }

    @Test
    void requestResetCommitsTokenBeforeSynchronousProviderCall() {
        List<String> events = new ArrayList<>();
        service = serviceWith(transactionRunner(events));
        User user = userWith(42L, "alice@example.com", "Alice");
        when(userRepository.findByEmailIgnoreCase("alice@example.com"))
            .thenReturn(Optional.of(user));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordResetTokenRepository.findByTokenHash(anyString())).thenReturn(Optional.empty());
        when(passwordResetTokenRepository.save(any(PasswordResetToken.class)))
            .thenAnswer(invocation -> invocation.getArgument(0));
        org.mockito.Mockito.doAnswer(invocation -> {
            events.add("provider:send");
            return null;
        }).when(emailSender).sendPasswordReset(any());

        service.requestReset("alice@example.com");

        assertThat(events).containsSubsequence(
            "database:begin", "database:commit", "outside:begin", "provider:send", "outside:complete");
    }

    @Test
    void confirmResetUpdatesPasswordRevokesRefreshTokensAndConsumesToken() {
        PasswordResetToken resetToken = new PasswordResetToken(
            42L, sha256Hex(RAW_TOKEN), OffsetDateTime.now().plusMinutes(30));
        User user = userWith(42L, "alice@example.com", "Alice");
        user.setPasswordHash("old-hash");
        when(passwordResetTokenRepository.findByTokenHash(sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(resetToken));
        when(passwordResetTokenRepository.findByTokenHashForUpdate(sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(resetToken));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordEncoder.encode("new-password-123")).thenReturn("new-hash");

        service.confirmReset(RAW_TOKEN, "new-password-123");

        assertThat(user.getPasswordHash()).isEqualTo("new-hash");
        assertThat(resetToken.getConsumedAt()).isNotNull();
        verify(userRepository).save(user);
        verify(refreshTokenService).revokeAllForUser(42L);
        verify(passwordResetTokenRepository).save(resetToken);
        InOrder lockOrder = inOrder(userRepository, passwordResetTokenRepository);
        lockOrder.verify(userRepository).findByIdForUpdate(42L);
        lockOrder.verify(passwordResetTokenRepository)
            .findByTokenHashForUpdate(sha256Hex(RAW_TOKEN));
    }

    @Test
    void confirmResetRejectsExpiredTokenWithoutChangingPassword() {
        PasswordResetToken resetToken = new PasswordResetToken(
            42L, sha256Hex(RAW_TOKEN), OffsetDateTime.now().minusMinutes(1));
        when(passwordResetTokenRepository.findByTokenHash(sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(resetToken));

        assertThatThrownBy(() -> service.confirmReset(RAW_TOKEN, "new-password-123"))
            .isInstanceOfSatisfying(ValidationException.class,
                ex -> assertThat(ex.slug()).isEqualTo("invalid_reset_token"));

        verify(userRepository, never()).findByIdForUpdate(any());
        verify(passwordResetTokenRepository, never()).findByTokenHashForUpdate(anyString());
        verify(userRepository, never()).save(any());
        verify(refreshTokenService, never()).revokeAllForUser(any());
        assertThat(resetToken.getConsumedAt()).isNull();
    }

    private static User userWith(long id, String email, String displayName) {
        User user = new User(email, "ignored-hash", displayName);
        try {
            var field = User.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(user, id);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
        return user;
    }

    private PasswordResetService serviceWith(AuthEmailTransactionRunner transactionRunner) {
        return new PasswordResetService(
            passwordResetTokenRepository,
            userRepository,
            passwordEncoder,
            refreshTokenService,
            emailSender,
            new SecureRandom(new byte[] { 1, 2, 3, 4 }),
            transactionRunner);
    }

    private static AuthEmailTransactionRunner transactionRunner(List<String> events) {
        return new AuthEmailTransactionRunner(
            recordingTransactions(events, "database"),
            recordingTransactions(events, "outside"));
    }

    private static TransactionOperations recordingTransactions(List<String> events, String name) {
        return new TransactionOperations() {
            @Override
            public <T> T execute(TransactionCallback<T> action) {
                events.add(name + ":begin");
                try {
                    return action.doInTransaction(new SimpleTransactionStatus());
                } finally {
                    events.add(name + ("database".equals(name) ? ":commit" : ":complete"));
                }
            }
        };
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hashed);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
