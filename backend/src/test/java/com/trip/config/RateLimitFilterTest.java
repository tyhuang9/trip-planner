package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;

/**
 * Unit tests for {@link RateLimitFilter#clientIp(HttpServletRequest, boolean)}. The
 * trust-proxy gate is the load-bearing piece — without it a directly-exposed
 * deployment would let any caller spoof their rate-limit key via
 * {@code X-Forwarded-For}.
 */
class RateLimitFilterTest {

    @Test
    void ignoresXForwardedForWhenTrustProxyDisabled() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getHeader("X-Forwarded-For")).thenReturn("1.2.3.4");
        when(req.getRemoteAddr()).thenReturn("10.0.0.1");

        assertThat(RateLimitFilter.clientIp(req, false)).isEqualTo("10.0.0.1");
    }

    @Test
    void honorsXForwardedForWhenTrustProxyEnabled() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getHeader("X-Forwarded-For")).thenReturn("1.2.3.4");
        when(req.getRemoteAddr()).thenReturn("10.0.0.1");

        assertThat(RateLimitFilter.clientIp(req, true)).isEqualTo("1.2.3.4");
    }

    @Test
    void honorsFirstEntryOfXForwardedForWhenTrustProxyEnabled() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getHeader("X-Forwarded-For")).thenReturn("1.2.3.4, 5.6.7.8, 9.9.9.9");
        when(req.getRemoteAddr()).thenReturn("10.0.0.1");

        assertThat(RateLimitFilter.clientIp(req, true)).isEqualTo("1.2.3.4");
    }

    @Test
    void fallsBackToRemoteAddrWhenHeaderMissingEvenWithTrustProxy() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getHeader("X-Forwarded-For")).thenReturn(null);
        when(req.getRemoteAddr()).thenReturn("10.0.0.1");

        assertThat(RateLimitFilter.clientIp(req, true)).isEqualTo("10.0.0.1");
    }

    @Test
    void fallsBackToRemoteAddrWhenHeaderBlankEvenWithTrustProxy() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getHeader("X-Forwarded-For")).thenReturn("   ");
        when(req.getRemoteAddr()).thenReturn("10.0.0.1");

        assertThat(RateLimitFilter.clientIp(req, true)).isEqualTo("10.0.0.1");
    }

    @Test
    void newAndLegacyShareRoutesUseOnePerIpBucket() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        RateLimitFilter filter = new RateLimitFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();
        String token = "abcdefghijklmnopqrstuvwxyz123456";
        String[] paths = {
            "/api/share/accept",
            "/api/share/guest",
            "/api/share/" + token + "/accept",
            "/api/share/" + token + "/guest",
            "/api/share/short/accept",
            "/api/share/invalid.token/guest",
            "/api/share/" + "a".repeat(201) + "/accept"
        };

        for (int i = 0; i < 10; i++) {
            MockHttpServletResponse response = new MockHttpServletResponse();
            filter.doFilter(request("POST", paths[i % paths.length]), response, chain);
            assertThat(response.getStatus()).isEqualTo(200);
        }

        assertThat(registry.size()).isEqualTo(1);

        MockHttpServletResponse limited = new MockHttpServletResponse();
        filter.doFilter(request("POST", "/api/share/accept"), limited, chain);

        assertThat(passed.get()).isEqualTo(10);
        assertThat(limited.getStatus()).isEqualTo(429);
        assertThat(limited.getContentAsString()).isEqualTo(RateLimitFilter.RATE_LIMITED_BODY);
        assertThat(limited.getHeader("Retry-After")).isNotBlank();
    }

    @Test
    void shareRateLimitIgnoresNearMissRoutes() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        RateLimitFilter filter = new RateLimitFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();
        String validToken = "abcdefghijklmnopqrstuvwxyz123456";
        String[] paths = {
            "/api/share/accept/extra",
            "/api/share/guest/extra",
            "/api/share/" + validToken + "/accept/extra",
            "/api/share/" + validToken + "/other",
            "/api/share//accept"
        };

        for (String path : paths) {
            filter.doFilter(request("POST", path), new MockHttpServletResponse(), chain);
        }

        assertThat(passed.get()).isEqualTo(paths.length);
        assertThat(registry.size()).isZero();
    }

    @Test
    void shareRateLimitDoesNotConsumeRequestBody() throws Exception {
        RateLimitFilter filter = new RateLimitFilter(new RateLimitRegistry(), new AppProperties());
        MockHttpServletRequest request = request("POST", "/api/share/accept");
        request.setContent("{\"token\":\"abcdefghijklmnopqrstuvwxyz123456\"}"
            .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        AtomicReference<String> downstreamBody = new AtomicReference<>();

        filter.doFilter(request, new MockHttpServletResponse(), (filteredRequest, _response) ->
            downstreamBody.set(new String(
                filteredRequest.getInputStream().readAllBytes(),
                java.nio.charset.StandardCharsets.UTF_8)));

        assertThat(downstreamBody.get())
            .isEqualTo("{\"token\":\"abcdefghijklmnopqrstuvwxyz123456\"}");
    }

    @Test
    void googleMapsProxyPathsShareRateLimitBucketPerClientIp() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        RateLimitFilter filter = new RateLimitFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();

        for (int i = 0; i < 60; i++) {
            MockHttpServletResponse response = new MockHttpServletResponse();
            filter.doFilter(request("POST", "/api/places/autocomplete"), response, chain);
            assertThat(response.getStatus()).isEqualTo(200);
        }
        for (int i = 0; i < 60; i++) {
            MockHttpServletResponse response = new MockHttpServletResponse();
            filter.doFilter(request("POST", "/api/maps/geocode"), response, chain);
            assertThat(response.getStatus()).isEqualTo(200);
        }

        assertThat(registry.size()).isEqualTo(1);

        MockHttpServletResponse limited = new MockHttpServletResponse();
        filter.doFilter(request("POST", "/api/maps/routes/driving"), limited, chain);

        assertThat(passed.get()).isEqualTo(120);
        assertThat(limited.getStatus()).isEqualTo(429);
        assertThat(limited.getContentAsString()).isEqualTo(RateLimitFilter.RATE_LIMITED_BODY);
    }

    @Test
    void authPasswordResetRequestPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/auth/password-reset/request", 10);
    }

    @Test
    void authPasswordResetConfirmPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/auth/password-reset/confirm", 10);
    }

    @Test
    void authEmailVerificationVerifyPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/auth/email/verify", 10);
    }

    @Test
    void authEmailVerificationResendPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/auth/email/resend", 10);
    }

    @Test
    void authRefreshPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/auth/refresh", 60);
    }

    @Test
    void authLogoutPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/auth/logout", 120);
    }

    @Test
    void authAccountDeletePathIsRateLimitedByClientIp() throws Exception {
        assertPathLimited("DELETE", "/api/auth/me", 10);
    }

    @Test
    void localDevLoginAsPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/dev/auth/login-as", 60);
    }

    @Test
    void localDevUsersPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/dev/users", 60);
    }

    @Test
    void localDevUsersReseedPathIsRateLimitedByClientIp() throws Exception {
        assertPostPathLimited("/api/dev/users/reseed", 60);
    }

    @Test
    void authRateLimitDoesNotCatchOtherAuthPaths() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        RateLimitFilter filter = new RateLimitFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request("POST", "/api/auth/me/password"), response, chain);

        assertThat(passed.get()).isEqualTo(1);
        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(registry.size()).isZero();
    }

    @Test
    void everyDatabaseBearingHealthGetSharesOneRateLimitBucketPerClientIp() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        RateLimitFilter filter = new RateLimitFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();
        String[] paths = {
            "/actuator/health",
            "/actuator/health/database",
            "/actuator/health/database/database"
        };
        String[] methods = {"GET", "HEAD"};

        for (int i = 0; i < 30; i++) {
            MockHttpServletResponse response = new MockHttpServletResponse();
            filter.doFilter(request(methods[i % methods.length], paths[i % paths.length]), response, chain);
            assertThat(response.getStatus()).isEqualTo(200);
        }
        assertThat(registry.size()).isEqualTo(1);

        MockHttpServletResponse limited = new MockHttpServletResponse();
        filter.doFilter(request("HEAD", "/actuator/health/database/database"), limited, chain);

        assertThat(passed.get()).isEqualTo(30);
        assertThat(limited.getStatus()).isEqualTo(429);
        assertThat(limited.getHeader("Retry-After")).isNotBlank();
        assertThat(limited.getContentAsString()).isEqualTo(RateLimitFilter.RATE_LIMITED_BODY);
    }

    @Test
    void livenessAndDatabaseHealthOptionsAreNotRateLimited() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        RateLimitFilter filter = new RateLimitFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();

        for (int i = 0; i < 40; i++) {
            filter.doFilter(request("GET", "/actuator/health/liveness"),
                new MockHttpServletResponse(), chain);
            filter.doFilter(request("HEAD", "/actuator/health/liveness"),
                new MockHttpServletResponse(), chain);
            filter.doFilter(request("OPTIONS", "/actuator/health/database"),
                new MockHttpServletResponse(), chain);
        }

        assertThat(passed.get()).isEqualTo(120);
        assertThat(registry.size()).isZero();
    }

    private static void assertPostPathLimited(String path, int capacity) throws Exception {
        assertPathLimited("POST", path, capacity);
    }

    private static void assertPathLimited(String method, String path, int capacity) throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        RateLimitFilter filter = new RateLimitFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();

        for (int i = 0; i < capacity; i++) {
            MockHttpServletResponse response = new MockHttpServletResponse();
            filter.doFilter(request(method, path), response, chain);
            assertThat(response.getStatus()).isEqualTo(200);
        }

        assertThat(registry.size()).isEqualTo(1);

        MockHttpServletResponse limited = new MockHttpServletResponse();
        filter.doFilter(request(method, path), limited, chain);

        assertThat(passed.get()).isEqualTo(capacity);
        assertThat(limited.getStatus()).isEqualTo(429);
        assertThat(limited.getContentAsString()).isEqualTo(RateLimitFilter.RATE_LIMITED_BODY);
        assertThat(limited.getHeader("Retry-After")).isNotBlank();
    }

    private static MockHttpServletRequest request(String method, String path) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, path);
        request.setRemoteAddr("203.0.113.41");
        return request;
    }
}
