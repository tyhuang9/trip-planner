package com.trip.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import jakarta.servlet.http.Cookie;

import org.hamcrest.Matchers;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.trip.config.RateLimitFilter;
import com.trip.domain.RefreshToken;
import com.trip.domain.User;
import com.trip.repo.ActivityRepository;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.JwtService;
import com.trip.service.auth.RefreshTokenService;
import com.trip.service.auth.RefreshTokenService.IssuedRefreshToken;
import com.trip.web.auth.AuthCookieAction;
import com.trip.web.auth.GuestSessionCookie;
import com.trip.web.auth.RefreshCookie;
import com.trip.web.dto.DeleteAccountRequest;

import io.micrometer.core.instrument.MeterRegistry;

/**
 * MockMvc tests for the chunk-2c auth endpoints: {@code GET/DELETE /api/auth/me},
 * {@code POST /api/auth/refresh}, {@code POST /api/auth/logout}.
 *
 * <p>Kept separate from {@link AuthControllerTest} to keep both files readable. The
 * {@code @SpringBootTest} setup matches: real filter chain (so the
 * {@link com.trip.web.auth.JwtAuthenticationFilter} runs), real Spring Security config,
 * mocked services + repository.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class AuthControllerMeTest {

    private static final String ACCOUNT_DELETION_COUNTER =
        "dupert.auth.account.deletion.attempts";

    @Autowired
    MockMvc mvc;

    @Autowired
    ObjectMapper objectMapper;

    @Autowired
    JwtService realJwtService;

    @Autowired
    AuthController authController;

    @Autowired
    MeterRegistry meterRegistry;

    @MockitoBean
    UserRepository userRepository;

    @MockitoBean
    RefreshTokenService refreshTokenService;

    @MockitoBean
    PasswordEncoder passwordEncoder;

    // TripAccessGuard (@Service) component-scans and pulls in the trip repos; the
    // test profile excludes JPA auto-config so we mock them like the auth repos above.
    @MockitoBean
    TripRepository tripRepository;

    @MockitoBean
    TripMemberRepository tripMemberRepository;

    @MockitoBean
    ActivityRepository activityRepository;

    @MockitoBean
    GuestSessionRepository guestSessionRepository;

    @MockitoBean
    PasswordResetTokenRepository passwordResetTokenRepository;

    @MockitoBean
    ShareLinkRepository shareLinkRepository;

    @BeforeEach
    void wireDefaults() {
        when(passwordEncoder.encode(anyString())).thenReturn("hashed");
    }

    // ------------------------------------------------------------------
    // GET /me
    // ------------------------------------------------------------------

    @Test
    void getMeWithValidBearerReturns200WithUserSummary() throws Exception {
        User user = userWith(42L, "alice@example.com", "Alice");
        when(userRepository.findById(42L)).thenReturn(Optional.of(user));
        when(tripRepository.findAllByOwnerId(42L)).thenReturn(List.of());
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(42))
            .andExpect(jsonPath("$.email").value("alice@example.com"))
            .andExpect(jsonPath("$.displayName").value("Alice"));
    }

    @Test
    void getMeWithNoBearerReturns401() throws Exception {
        mvc.perform(get("/api/auth/me"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void getMeWithMalformedBearerReturns401() throws Exception {
        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer not-a-jwt"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void getMeForDeletedUserReturns401() throws Exception {
        // Token verifies but the user row is gone (race with DELETE /me).
        when(userRepository.findById(42L)).thenReturn(Optional.empty());
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error").value("unauthenticated"));
    }

    // ------------------------------------------------------------------
    // PATCH /me/profile
    // ------------------------------------------------------------------

    @Test
    void updateProfileSanitizesDisplayNameAndReturnsUserSummary() throws Exception {
        User user = userWith(42L, "alice@example.com", "Old Name");
        when(userRepository.findById(42L)).thenReturn(Optional.of(user));
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> invocation.getArgument(0));
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(patch("/api/auth/me/profile")
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("displayName", "  Alice\r\n"))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(42))
            .andExpect(jsonPath("$.email").value("alice@example.com"))
            .andExpect(jsonPath("$.displayName").value("Alice"));

        verify(userRepository).save(user);
    }

    @Test
    void updateProfileRejectsNameThatSanitizesBlank() throws Exception {
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(patch("/api/auth/me/profile")
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("displayName", "\u202E\u2066"))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("invalid_display_name"));

        verify(userRepository, never()).save(any(User.class));
    }

    // ------------------------------------------------------------------
    // POST /me/password
    // ------------------------------------------------------------------

    @Test
    void changePasswordVerifiesCurrentPasswordUpdatesHashAndRevokesRefreshTokens() throws Exception {
        User user = userWith(42L, "alice@example.com", "Alice");
        user.setPasswordHash("old-hash");
        when(userRepository.findPasswordHashById(42L)).thenReturn(Optional.of("old-hash"));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordEncoder.matches("old-password", "old-hash")).thenReturn(true);
        when(passwordEncoder.encode("new-password-123")).thenReturn("new-hash");
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(post("/api/auth/me/password")
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "currentPassword", "old-password",
                    "newPassword", "new-password-123"))))
            .andExpect(status().isNoContent());

        org.assertj.core.api.Assertions.assertThat(user.getPasswordHash()).isEqualTo("new-hash");
        verify(userRepository).save(user);
        verify(refreshTokenService).revokeAllForUser(42L);
    }

    @Test
    void changePasswordRejectsWrongCurrentPassword() throws Exception {
        when(userRepository.findPasswordHashById(42L)).thenReturn(Optional.of("old-hash"));
        when(passwordEncoder.matches("wrong-password", "old-hash")).thenReturn(false);
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(post("/api/auth/me/password")
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "currentPassword", "wrong-password",
                    "newPassword", "new-password-123"))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("invalid_current_password"));

        verify(userRepository, never()).save(any(User.class));
        verify(refreshTokenService, never()).revokeAllForUser(any());
    }

    // ------------------------------------------------------------------
    // POST /refresh
    // ------------------------------------------------------------------

    @Test
    void refreshWithValidCookieRotatesAndIssuesNewAccessToken() throws Exception {
        User user = userWith(11L, "bob@example.com", "Bob");
        when(userRepository.findById(11L)).thenReturn(Optional.of(user));
        IssuedRefreshToken issued = new IssuedRefreshToken(
            "new-raw-refresh-token", refreshTokenEntity(11L));
        when(refreshTokenService.rotate("old-raw-refresh-token"))
            .thenReturn(Optional.of(issued));

        mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction())
                .cookie(new Cookie("refresh_token", "old-raw-refresh-token")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.accessToken").exists())
            .andExpect(jsonPath("$.tokenType").value("Bearer"))
            .andExpect(jsonPath("$.user.id").value(11))
            // The Set-Cookie header carries the *new* raw refresh token.
            .andExpect(header().string("Set-Cookie",
                Matchers.containsString("refresh_token=new-raw-refresh-token")))
            .andExpect(header().string("Set-Cookie",
                Matchers.not(Matchers.containsString("refresh_token=old-raw-refresh-token"))));
    }

    @Test
    void refreshRequiresAuthCookieActionHeader() throws Exception {
        mvc.perform(post("/api/auth/refresh"))
            .andExpect(status().isForbidden());
        verify(refreshTokenService, never()).rotate(anyString());
    }

    @Test
    void refreshWithNoCookieReturns401AndClearsCookie() throws Exception {
        mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction()))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error").value("unauthenticated"))
            .andExpect(cookie().maxAge("refresh_token", 0));
        verify(refreshTokenService, never()).rotate(anyString());
    }

    @Test
    void refreshWithUnknownCookieReturns401AndClearsCookie() throws Exception {
        when(refreshTokenService.rotate("ghost-token")).thenReturn(Optional.empty());

        mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction())
                .cookie(new Cookie("refresh_token", "ghost-token")))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error").value("unauthenticated"))
            .andExpect(cookie().maxAge("refresh_token", 0));
    }

    @Test
    void refreshTriggersReuseDetectionReturns401AndClearsCookie() throws Exception {
        // RefreshTokenService.rotate() returns empty when reuse is detected (it has
        // already revoked the chain internally). The controller treats that the same as
        // any other invalid refresh.
        when(refreshTokenService.rotate("revoked-token")).thenReturn(Optional.empty());

        mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction())
                .cookie(new Cookie("refresh_token", "revoked-token")))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error").value("unauthenticated"))
            .andExpect(cookie().maxAge("refresh_token", 0));
    }

    @Test
    void refreshForDeletedUserRevokesAndReturns401() throws Exception {
        // rotate() succeeds but the user has been deleted in the meantime.
        IssuedRefreshToken issued = new IssuedRefreshToken(
            "fresh-tok", refreshTokenEntity(99L));
        when(refreshTokenService.rotate("valid-old")).thenReturn(Optional.of(issued));
        when(userRepository.findById(99L)).thenReturn(Optional.empty());

        mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction())
                .cookie(new Cookie("refresh_token", "valid-old")))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error").value("unauthenticated"))
            .andExpect(cookie().maxAge(RefreshCookie.COOKIE_NAME, 0));

        // The just-issued token must be revoked so the attacker can't reuse it.
        verify(refreshTokenService).revokeAllForUser(99L);
    }

    // ------------------------------------------------------------------
    // POST /logout
    // ------------------------------------------------------------------

    @Test
    void logoutWithValidCookieReturns204AndRevokesAndClears() throws Exception {
        mvc.perform(post("/api/auth/logout")
                .with(authCookieAction())
                .cookie(new Cookie("refresh_token", "session-token")))
            .andExpect(status().isNoContent())
            .andExpect(cookie().maxAge("refresh_token", 0));

        verify(refreshTokenService).revokeByRawToken("session-token");
    }

    @Test
    void logoutWithNoCookieReturns204Idempotent() throws Exception {
        mvc.perform(post("/api/auth/logout")
                .with(authCookieAction()))
            .andExpect(status().isNoContent())
            .andExpect(cookie().maxAge("refresh_token", 0));

        verify(refreshTokenService, never()).revokeByRawToken(anyString());
    }

    @Test
    void logoutRequiresAuthCookieActionHeader() throws Exception {
        mvc.perform(post("/api/auth/logout")
                .cookie(new Cookie("refresh_token", "session-token")))
            .andExpect(status().isForbidden());

        verify(refreshTokenService, never()).revokeByRawToken(anyString());
    }

    // ------------------------------------------------------------------
    // DELETE /me
    // ------------------------------------------------------------------

    @Test
    void deleteMeHappyPathRevokesTokensDeletesUserAndClearsCookie() throws Exception {
        double outcomeBefore = accountDeletionCount("success");
        double totalBefore = totalAccountDeletionCount();
        User user = userWith(42L, "alice@example.com", "Alice");
        when(userRepository.findPasswordHashById(42L))
            .thenReturn(Optional.of("ignored-hash"));
        when(userRepository.findByIdForUpdate(42L)).thenReturn(Optional.of(user));
        when(passwordEncoder.matches("current-secret", "ignored-hash")).thenReturn(true);
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(
                    Map.of("currentPassword", "current-secret"))))
            .andExpect(status().isNoContent())
            .andExpect(cookie().maxAge("refresh_token", 0));

        verify(passwordEncoder).matches("current-secret", "ignored-hash");
        verify(refreshTokenService, times(1)).revokeAllForUser(42L);
        verify(userRepository, times(1)).delete(user);
        assertThatSingleOutcomeIncreased("success", outcomeBefore, totalBefore);
    }

    @Test
    void deleteMeWithoutBearerReturns401() throws Exception {
        mvc.perform(delete("/api/auth/me")
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(
                    Map.of("currentPassword", "current-secret"))))
            .andExpect(status().isUnauthorized());
        verify(refreshTokenService, never()).revokeAllForUser(any());
        verify(userRepository, never()).delete(any(User.class));
    }

    @Test
    void deleteMeWithGuestCookieReturns401() throws Exception {
        mvc.perform(delete("/api/auth/me")
                .cookie(new Cookie(GuestSessionCookie.COOKIE_NAME, "guest-session-token"))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(
                    Map.of("currentPassword", "current-secret"))))
            .andExpect(status().isUnauthorized());

        verify(refreshTokenService, never()).revokeAllForUser(any());
        verify(userRepository, never()).delete(any(User.class));
    }

    @Test
    void deleteMeWhenUserAlreadyGoneReturns401WithoutClearingCookie() throws Exception {
        double outcomeBefore = accountDeletionCount("user_missing");
        double totalBefore = totalAccountDeletionCount();
        when(userRepository.findPasswordHashById(42L)).thenReturn(Optional.empty());
        String token = realJwtService.issueAccessToken(42L);

        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + token)
                .cookie(new Cookie("refresh_token", "existing-session"))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(
                    Map.of("currentPassword", "current-secret"))))
            .andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.error").value("unauthenticated"))
            .andExpect(header().doesNotExist("Set-Cookie"));

        verify(passwordEncoder, never()).matches(anyString(), anyString());
        verify(refreshTokenService, never()).revokeAllForUser(any());
        verify(userRepository, never()).delete(any(User.class));
        assertThatSingleOutcomeIncreased("user_missing", outcomeBefore, totalBefore);
    }

    @Test
    void deleteMeWithWrongPasswordReturns403AndPreservesAccountAndSession() throws Exception {
        double outcomeBefore = accountDeletionCount("fresh_auth_rejected");
        double totalBefore = totalAccountDeletionCount();
        when(userRepository.findPasswordHashById(43L))
            .thenReturn(Optional.of("ignored-hash"));
        when(passwordEncoder.matches("incorrect-secret", "ignored-hash")).thenReturn(false);
        String token = realJwtService.issueAccessToken(43L);

        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + token)
                .cookie(new Cookie("refresh_token", "existing-session"))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(
                    Map.of("currentPassword", "incorrect-secret"))))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.error").value("reauthentication_failed"))
            .andExpect(header().doesNotExist("Set-Cookie"));

        verify(refreshTokenService, never()).revokeAllForUser(any());
        verify(tripRepository, never()).findAllByOwnerId(any());
        verify(userRepository, never()).delete(any(User.class));
        assertThatSingleOutcomeIncreased("fresh_auth_rejected", outcomeBefore, totalBefore);
    }

    @Test
    void deleteMeRejectsBlankPasswordBody() throws Exception {
        String token = realJwtService.issueAccessToken(44L);

        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("currentPassword", ""))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("validation_failed"));

        verify(userRepository, never()).findPasswordHashById(44L);
        verify(passwordEncoder, never()).matches(anyString(), anyString());
    }

    @Test
    void deleteMeRejectsOversizedPasswordBody() throws Exception {
        String token = realJwtService.issueAccessToken(45L);

        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(
                    Map.of("currentPassword", "x".repeat(129)))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("validation_failed"));

        verify(userRepository, never()).findPasswordHashById(45L);
        verify(passwordEncoder, never()).matches(anyString(), anyString());
    }

    @Test
    void deleteMeRateLimitsPerUserBeforeAdditionalPasswordVerification() throws Exception {
        double rejectedBefore = accountDeletionCount("fresh_auth_rejected");
        double throttledBefore = accountDeletionCount("user_throttled");
        double totalBefore = totalAccountDeletionCount();
        when(userRepository.findPasswordHashById(88L))
            .thenReturn(Optional.of("ignored-hash"));
        when(passwordEncoder.matches(anyString(), anyString())).thenReturn(false);
        String token = realJwtService.issueAccessToken(88L);

        for (int attempt = 0; attempt < 5; attempt++) {
            mvc.perform(delete("/api/auth/me")
                    .with(remoteAddress("203.0.113.88"))
                    .header("Authorization", "Bearer " + token)
                    .contentType("application/json")
                    .content(objectMapper.writeValueAsString(
                        Map.of("currentPassword", "incorrect-secret"))))
                .andExpect(status().isForbidden());
        }

        mvc.perform(delete("/api/auth/me")
                .with(remoteAddress("203.0.113.88"))
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(
                    Map.of("currentPassword", "incorrect-secret"))))
            .andExpect(status().isTooManyRequests())
            .andExpect(header().exists("Retry-After"))
            .andExpect(content().string(RateLimitFilter.RATE_LIMITED_BODY));

        verify(passwordEncoder, times(5)).matches("incorrect-secret", "ignored-hash");
        verify(refreshTokenService, never()).revokeAllForUser(any());
        verify(userRepository, never()).delete(any(User.class));
        assertThat(accountDeletionCount("fresh_auth_rejected"))
            .isEqualTo(rejectedBefore + 5.0);
        assertThat(accountDeletionCount("user_throttled"))
            .isEqualTo(throttledBefore + 1.0);
        assertThat(totalAccountDeletionCount())
            .isEqualTo(totalBefore + 6.0);
    }

    @Test
    void deleteMeRecordsTransactionFailureAndRethrowsTheSameException() {
        double outcomeBefore = accountDeletionCount("transaction_failed");
        double totalBefore = totalAccountDeletionCount();
        IllegalStateException failure = new IllegalStateException("simulated transaction failure");
        when(userRepository.findPasswordHashById(46L)).thenThrow(failure);
        Authentication authentication = mock(Authentication.class);
        when(authentication.isAuthenticated()).thenReturn(true);
        when(authentication.getPrincipal()).thenReturn(46L);

        assertThatThrownBy(() -> authController.deleteMe(
            new DeleteAccountRequest("current-secret"),
            authentication,
            new MockHttpServletResponse()))
            .isSameAs(failure);

        assertThatSingleOutcomeIncreased("transaction_failed", outcomeBefore, totalBefore);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private double accountDeletionCount(String outcome) {
        return meterRegistry.get(ACCOUNT_DELETION_COUNTER)
            .tag("outcome", outcome)
            .counter()
            .count();
    }

    private double totalAccountDeletionCount() {
        return meterRegistry.get(ACCOUNT_DELETION_COUNTER)
            .counters()
            .stream()
            .mapToDouble(counter -> counter.count())
            .sum();
    }

    private void assertThatSingleOutcomeIncreased(String outcome,
                                                   double outcomeBefore,
                                                   double totalBefore) {
        assertThat(accountDeletionCount(outcome))
            .isEqualTo(outcomeBefore + 1.0);
        assertThat(totalAccountDeletionCount())
            .isEqualTo(totalBefore + 1.0);
    }

    private static User userWith(long id, String email, String displayName) {
        User u = new User(email, "ignored-hash", displayName);
        try {
            var f = User.class.getDeclaredField("id");
            f.setAccessible(true);
            f.set(u, id);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
        return u;
    }

    private static RequestPostProcessor authCookieAction() {
        return request -> {
            request.addHeader(AuthCookieAction.HEADER, AuthCookieAction.VALUE);
            return request;
        };
    }

    private static RequestPostProcessor remoteAddress(String address) {
        return request -> {
            request.setRemoteAddr(address);
            return request;
        };
    }

    private static RefreshToken refreshTokenEntity(long userId) {
        return new RefreshToken(userId, "hash", OffsetDateTime.now().plusDays(30));
    }
}
