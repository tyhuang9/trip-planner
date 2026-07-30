package com.trip.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.trip.domain.User;
import com.trip.repo.UserRepository;
import com.trip.service.auth.EmailVerificationOperations;
import com.trip.service.auth.JwtService;
import com.trip.web.auth.AuthCookieAction;
import com.trip.web.dto.DeleteAccountRequest;
import com.trip.web.dto.LoginRequest;
import com.trip.web.dto.RegisterRequest;

import jakarta.servlet.http.Cookie;

/**
 * End-to-end auth flow against a real Postgres (Neon, dev branch via {@code DATABASE_URL}).
 *
 * <p><b>How to run.</b> The test is gated on {@code INTEGRATION=true} so {@code ./gradlew
 * test} skips it by default. To run:
 * <pre>{@code
 *   cd /home/tyhuang/Projects/dupert
 *   set -a && source .env && set +a
 *   cd backend
 *   INTEGRATION=true ./gradlew test --tests AuthFlowIntegrationTest
 * }</pre>
 *
 * <p><b>Cleanup.</b> Each test generates a unique email and deletes the user row in
 * {@code @AfterEach}. If the test crashes mid-flight, the leftover row will collide on
 * the next run with the same email — but since emails are randomized per test, that's
 * benign. There is no schema isolation; we share the dev schema.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("dev")
@EnabledIfEnvironmentVariable(named = "INTEGRATION", matches = "true")
class AuthFlowIntegrationTest {

    @Autowired
    MockMvc mvc;

    @Autowired
    ObjectMapper objectMapper;

    @Autowired
    UserRepository userRepository;

    @Autowired
    JwtService jwtService;

    @MockitoBean
    EmailVerificationOperations emailVerificationService;

    private String testEmail;

    @AfterEach
    void cleanup() {
        if (testEmail != null) {
            userRepository.findByEmailIgnoreCase(testEmail)
                .ifPresent(userRepository::delete);
        }
    }

    @Test
    void registerThenVerifiedLoginIssuesAJwtThatVerifies() throws Exception {
        testEmail = "auth-it-" + UUID.randomUUID() + "@example.com";

        // 1. Register. Non-local profiles create a pending user and require email
        // verification before tokens are issued.
        mvc.perform(post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new RegisterRequest(testEmail, "password1234", "Integration Test"))))
            .andExpect(status().isAccepted())
            .andExpect(jsonPath("$.status").value("verification_required"))
            .andExpect(jsonPath("$.email").value(testEmail));

        User registered = markRegisteredUserVerified("Integration Test");
        long registeredUserId = registered.getId();

        // 2. Login with the same credentials
        MvcResult loginResult = mvc.perform(post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new LoginRequest(testEmail, "password1234"))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.accessToken").exists())
            .andExpect(jsonPath("$.user.id").value(registeredUserId))
            .andReturn();

        String loginToken = objectMapper.readTree(loginResult.getResponse().getContentAsString())
            .get("accessToken").asText();

        Optional<Long> loginUid = jwtService.verifyAccessToken(loginToken);
        assertThat(loginUid).contains(registeredUserId);

        // 3. The DB row is real — confirm it via the repo (defense in depth).
        Optional<User> loaded = userRepository.findByEmailIgnoreCase(testEmail);
        assertThat(loaded).isPresent();
        assertThat(loaded.get().getDisplayName()).isEqualTo("Integration Test");
    }

    /**
     * Full chunk-2c happy path: register → login → /me → /refresh → /me with new
     * access token → logout → /me with old access token still works (until expiry —
     * access tokens aren't revocable mid-flight; see PROJECT.md §5) → /refresh fails
     * because the cookie chain is gone.
     */
    @Test
    void fullSessionLifecycleAcrossRefreshAndLogout() throws Exception {
        testEmail = "auth-it-" + UUID.randomUUID() + "@example.com";

        // 1. Register, mark verified, then login and capture the refresh cookie.
        mvc.perform(post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new RegisterRequest(testEmail, "password1234", "Lifecycle Test"))))
            .andExpect(status().isAccepted())
            .andExpect(jsonPath("$.status").value("verification_required"));
        markRegisteredUserVerified("Lifecycle Test");

        MvcResult loggedIn = mvc.perform(post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new LoginRequest(testEmail, "password1234"))))
            .andExpect(status().isOk())
            .andReturn();

        Cookie registerCookie = loggedIn.getResponse().getCookie("refresh_token");
        assertThat(registerCookie).isNotNull();
        String firstAccessToken = objectMapper.readTree(
            loggedIn.getResponse().getContentAsString()).get("accessToken").asText();

        // 2. /me with the bearer.
        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + firstAccessToken))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.email").value(testEmail));

        // 3. Refresh — rotates the cookie and mints a new access token.
        MvcResult refreshed = mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction())
                .cookie(registerCookie))
            .andExpect(status().isOk())
            .andReturn();
        Cookie rotatedCookie = refreshed.getResponse().getCookie("refresh_token");
        assertThat(rotatedCookie).isNotNull();
        assertThat(rotatedCookie.getValue()).isNotEqualTo(registerCookie.getValue());
        String secondAccessToken = objectMapper.readTree(
            refreshed.getResponse().getContentAsString()).get("accessToken").asText();
        assertThat(jwtService.verifyAccessToken(secondAccessToken)).isPresent();

        // 4. /me with the new access token.
        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + secondAccessToken))
            .andExpect(status().isOk());

        // 5. Logout — revokes the rotated cookie's refresh row, sets Max-Age=0 on the
        //    response cookie.
        mvc.perform(post("/api/auth/logout")
                .with(authCookieAction())
                .cookie(rotatedCookie))
            .andExpect(status().isNoContent());

        // 6. The old access token still works because access tokens are short-lived
        //    bearer artefacts and not revocable mid-flight (PROJECT.md §5). Documented
        //    expected behaviour: the user is "logged out" only in the sense that they
        //    can't get a new access token after the current one expires.
        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + secondAccessToken))
            .andExpect(status().isOk());

        // Step 7: presenting the just-logged-out cookie to /refresh hits the
        // "revoked token" branch of rotate(), which fires chain revocation.
        mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction())
                .cookie(rotatedCookie))
            .andExpect(status().isUnauthorized());

        // 8. DELETE /me cleans up everything; the @AfterEach cleanup becomes a no-op.
        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + secondAccessToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new DeleteAccountRequest("password1234"))))
            .andExpect(status().isNoContent());
        assertThat(userRepository.findByEmailIgnoreCase(testEmail)).isEmpty();
    }

    @Test
    void wrongDeletionPasswordPreservesRefreshSessionBeforeSuccessfulDeletion() throws Exception {
        testEmail = "auth-it-" + UUID.randomUUID() + "@example.com";

        mvc.perform(post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new RegisterRequest(testEmail, "password1234", "Deletion Test"))))
            .andExpect(status().isAccepted());
        markRegisteredUserVerified("Deletion Test");

        MvcResult loggedIn = mvc.perform(post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new LoginRequest(testEmail, "password1234"))))
            .andExpect(status().isOk())
            .andReturn();
        Cookie refreshCookie = loggedIn.getResponse().getCookie("refresh_token");
        assertThat(refreshCookie).isNotNull();
        String firstAccessToken = objectMapper.readTree(
            loggedIn.getResponse().getContentAsString()).get("accessToken").asText();

        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + firstAccessToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new DeleteAccountRequest("not-the-password"))))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.error").value("reauthentication_failed"));

        MvcResult refreshed = mvc.perform(post("/api/auth/refresh")
                .with(authCookieAction())
                .cookie(refreshCookie))
            .andExpect(status().isOk())
            .andReturn();
        Cookie rotatedCookie = refreshed.getResponse().getCookie("refresh_token");
        assertThat(rotatedCookie).isNotNull();
        String refreshedAccessToken = objectMapper.readTree(
            refreshed.getResponse().getContentAsString()).get("accessToken").asText();

        mvc.perform(delete("/api/auth/me")
                .header("Authorization", "Bearer " + refreshedAccessToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                    new DeleteAccountRequest("password1234"))))
            .andExpect(status().isNoContent());
        assertThat(userRepository.findByEmailIgnoreCase(testEmail)).isEmpty();
    }

    private User markRegisteredUserVerified(String expectedDisplayName) {
        User user = userRepository.findByEmailIgnoreCase(testEmail).orElseThrow();
        assertThat(user.getDisplayName()).isEqualTo(expectedDisplayName);
        user.markEmailVerified(OffsetDateTime.now());
        return userRepository.save(user);
    }

    private static RequestPostProcessor authCookieAction() {
        return request -> {
            request.addHeader(AuthCookieAction.HEADER, AuthCookieAction.VALUE);
            return request;
        };
    }
}
