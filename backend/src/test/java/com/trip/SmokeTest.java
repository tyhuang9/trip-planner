package com.trip;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.not;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.head;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.actuate.health.HealthEndpointGroup;
import org.springframework.boot.actuate.health.HealthEndpointGroups;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.trip.repo.ActivityRepository;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;

/**
 * Piece 1 smoke tests. Focus: security headers, CORS allowlist, sanitized errors,
 * CSP emission. No feature endpoints exist yet, so every {@code /api/**} hit
 * hits the Spring Security 401 entry point.
 *
 * <p>We use {@code @SpringBootTest} + {@code @AutoConfigureMockMvc} with the
 * {@code test} profile so the real filter chain (headers, CSP, correlation id,
 * security) runs exactly as in production. The test profile excludes DataSource
 * autoconfig — Piece 2 will add a proper DB-backed integration test.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class SmokeTest {

    @Autowired
    MockMvc mvc;

    @Autowired
    HealthEndpointGroups healthEndpointGroups;

    // The chunk-2b @Service annotations on JwtService and RefreshTokenService pull
    // UserRepository and RefreshTokenRepository into the bean graph. The test profile
    // excludes JPA auto-config, so we mock the repos to satisfy the constructor-injected
    // dependencies without spinning up a datasource.
    @MockitoBean
    UserRepository userRepository;

    @MockitoBean
    RefreshTokenRepository refreshTokenRepository;

    // TripAccessGuard (@Service) is component-scanned and pulls TripRepository +
    // TripMemberRepository into the bean graph; test profile excludes JPA auto-config,
    // so we mock these repos for the same reason as the auth ones above.
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

    @Test
    void rootHealthReflectsDatabaseReadiness() throws Exception {
        mvc.perform(get("/actuator/health"))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.status").exists());
    }

    @Test
    void livenessEndpointIsPublicAndReturns200() throws Exception {
        mvc.perform(get("/actuator/health/liveness"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void livenessGroupExcludesDatabaseAndExternalProviders() {
        HealthEndpointGroup liveness = healthEndpointGroups.get("liveness");

        assertThat(liveness).isNotNull();
        assertThat(liveness.isMember("livenessState")).isTrue();
        assertThat(liveness.isMember("database")).isFalse();
        assertThat(liveness.isMember("googleMaps")).isFalse();
        assertThat(liveness.isMember("brevo")).isFalse();
    }

    @Test
    void databaseHealthGroupContainsOnlyTheDatabaseIndicator() {
        HealthEndpointGroup database = healthEndpointGroups.get("database");

        assertThat(database).isNotNull();
        assertThat(database.isMember("database")).isTrue();
        assertThat(database.isMember("livenessState")).isFalse();
        assertThat(database.isMember("googleMaps")).isFalse();
        assertThat(database.isMember("brevo")).isFalse();
    }

    @Test
    void databaseHealthEndpointIsPublicAndSanitized() throws Exception {
        mvc.perform(get("/actuator/health/database"))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.status").exists())
            .andExpect(jsonPath("$.components").doesNotExist());
    }

    @Test
    void databaseHealthHeadRequestsShareTheLimiterWhileLivenessHeadRemainsAvailable() throws Exception {
        for (int i = 0; i < 30; i++) {
            mvc.perform(head("/actuator/health/database")
                    .with(request -> {
                        request.setRemoteAddr("198.51.100.72");
                        return request;
                    }))
                .andExpect(status().isServiceUnavailable());
        }

        mvc.perform(head("/actuator/health/database/database")
                .with(request -> {
                    request.setRemoteAddr("198.51.100.72");
                    return request;
                }))
            .andExpect(status().isTooManyRequests())
            .andExpect(header().exists("Retry-After"));

        mvc.perform(head("/actuator/health/liveness")
                .with(request -> {
                    request.setRemoteAddr("198.51.100.72");
                    return request;
                }))
            .andExpect(status().isOk());
    }

    @Test
    void unknownApiPathReturnsSanitized401() throws Exception {
        // Unknown /api/** paths resolve to the "authenticated" matcher and the
        // security entry point returns 401. The body must never contain a stack
        // trace, exception class, or request body echo.
        mvc.perform(get("/api/does-not-exist"))
            .andExpect(status().isUnauthorized())
            .andExpect(content().string(not(containsString("Exception"))))
            .andExpect(content().string(not(containsString("at com."))))
            .andExpect(content().string(not(containsString("stacktrace"))));
    }

    @Test
    void apiResponseHasSecurityHeaders() throws Exception {
        mvc.perform(get("/api/does-not-exist"))
            .andExpect(header().string("X-Content-Type-Options", "nosniff"))
            .andExpect(header().string("X-Frame-Options", "DENY"))
            .andExpect(header().string("Referrer-Policy", "strict-origin-when-cross-origin"))
            .andExpect(header().string("Cache-Control", "no-store, private"))
            .andExpect(header().string("X-Correlation-Id", not(nullValue())));
    }

    @Test
    void cspHeaderIsEmitted() throws Exception {
        mvc.perform(get("/api/does-not-exist"))
            .andExpect(header().string("Content-Security-Policy",
                containsString("default-src 'self'")))
            .andExpect(header().string("Content-Security-Policy",
                containsString("maps.googleapis.com")))
            .andExpect(header().string("Content-Security-Policy",
                containsString("maps.gstatic.com")))
            .andExpect(header().string("Content-Security-Policy",
                not(containsString("places.googleapis.com"))))
            .andExpect(header().string("Content-Security-Policy",
                not(containsString("routes.googleapis.com"))))
            .andExpect(header().string("Content-Security-Policy",
                not(containsString("place.com"))))
            .andExpect(header().string("Content-Security-Policy",
                containsString("frame-ancestors 'none'")));
    }

    @Test
    void corsPreflightFromAllowedOriginIsAccepted() throws Exception {
        mvc.perform(options("/api/anything")
                .header("Origin", "http://localhost:3000")
                .header("Access-Control-Request-Method", "GET"))
            .andExpect(status().isOk())
            .andExpect(header().string("Access-Control-Allow-Origin",
                equalTo("http://localhost:3000")));
    }

    @Test
    void corsPreflightFromLocalLoopbackAliasIsAcceptedInDevelopment() throws Exception {
        mvc.perform(options("/api/anything")
                .header("Origin", "http://127.0.0.1:3000")
                .header("Access-Control-Request-Method", "GET"))
            .andExpect(status().isOk())
            .andExpect(header().string("Access-Control-Allow-Origin",
                equalTo("http://127.0.0.1:3000")));
    }

    @Test
    void corsPreflightFromLocalBindAddressIsAcceptedInDevelopment() throws Exception {
        mvc.perform(options("/api/anything")
                .header("Origin", "http://0.0.0.0:3000")
                .header("Access-Control-Request-Method", "GET"))
            .andExpect(status().isOk())
            .andExpect(header().string("Access-Control-Allow-Origin",
                equalTo("http://0.0.0.0:3000")));
    }

    @Test
    void healthProbeCorsUsesTheExactConfiguredOrigin() throws Exception {
        mvc.perform(options("/actuator/health/liveness")
                .header("Origin", "http://localhost:3000")
                .header("Access-Control-Request-Method", "GET"))
            .andExpect(status().isOk())
            .andExpect(header().string("Access-Control-Allow-Origin",
                equalTo("http://localhost:3000")))
            .andExpect(header().doesNotExist("Access-Control-Allow-Credentials"));
    }

    @Test
    void corsPreflightFromEvilOriginIsRejected() throws Exception {
        mvc.perform(options("/api/anything")
                .header("Origin", "http://evil.example")
                .header("Access-Control-Request-Method", "GET"))
            // Spring's CORS filter responds without an Allow-Origin header when the
            // origin fails the allowlist — which is exactly the "rejected" behavior
            // the browser relies on.
            .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    @Test
    void hstsNotEmittedWhenDisabled() throws Exception {
        // secure.hsts.enabled=false in the test profile — HSTS header must not leak.
        mvc.perform(get("/api/does-not-exist"))
            .andExpect(header().doesNotExist("Strict-Transport-Security"));
    }
}
