package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

import com.trip.web.auth.GuestAuthenticationFilter;
import com.trip.web.auth.GuestSessionCookie;

import jakarta.servlet.FilterChain;
import jakarta.servlet.http.Cookie;

class GuestAuthenticationFilterRateLimitTest {

    @Test
    void guestWriteRateLimitIgnoresGuestTokenDiscriminator() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        GuestAuthenticationFilter filter = new GuestAuthenticationFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();

        for (int i = 0; i < 60; i++) {
            MockHttpServletResponse response = doGuestWrite(filter, chain, "guest-token-" + i);
            assertThat(response.getStatus()).isEqualTo(200);
        }

        assertThat(registry.size()).isEqualTo(1);

        MockHttpServletResponse limited = doGuestWrite(filter, chain, "guest-token-overflow");

        assertThat(passed.get()).isEqualTo(60);
        assertThat(limited.getStatus()).isEqualTo(429);
        assertThat(limited.getContentAsString()).isEqualTo(RateLimitFilter.RATE_LIMITED_BODY);
    }

    @Test
    void authPostWithGuestCookieDoesNotRequireGuestWriteHeader() throws Exception {
        RateLimitRegistry registry = new RateLimitRegistry();
        GuestAuthenticationFilter filter = new GuestAuthenticationFilter(registry, new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> passed.incrementAndGet();

        SecurityContextHolder.clearContext();
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/auth/login");
        request.setRemoteAddr("203.0.113.51");
        request.setCookies(new Cookie(GuestSessionCookie.COOKIE_NAME, "guest-token"));
        MockHttpServletResponse response = new MockHttpServletResponse();

        try {
            filter.doFilter(request, response, chain);
        } finally {
            SecurityContextHolder.clearContext();
        }

        assertThat(passed.get()).isEqualTo(1);
        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(response.getContentAsString()).isEmpty();
        assertThat(registry.size()).isZero();
    }

    @Test
    void memberShareAcceptPathsDoNotInstallGuestPrincipalFromCookie() throws Exception {
        GuestAuthenticationFilter filter = new GuestAuthenticationFilter(
            new RateLimitRegistry(), new AppProperties());
        AtomicInteger passed = new AtomicInteger();
        FilterChain chain = (_request, _response) -> {
            assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
            passed.incrementAndGet();
        };

        for (String path : new String[] {"/api/share/accept", "/api/share/opaque-token/accept"}) {
            SecurityContextHolder.clearContext();
            MockHttpServletRequest request = new MockHttpServletRequest("POST", path);
            request.setCookies(new Cookie(GuestSessionCookie.COOKIE_NAME, "stale-guest-token"));
            MockHttpServletResponse response = new MockHttpServletResponse();

            try {
                filter.doFilter(request, response, chain);
            } finally {
                SecurityContextHolder.clearContext();
            }

            assertThat(response.getStatus()).isEqualTo(200);
        }

        assertThat(passed.get()).isEqualTo(2);
    }

    private static MockHttpServletResponse doGuestWrite(GuestAuthenticationFilter filter,
                                                        FilterChain chain,
                                                        String guestToken) throws Exception {
        SecurityContextHolder.clearContext();
        MockHttpServletRequest request = new MockHttpServletRequest(
            "POST", "/api/trips/abc23def45gh/activities");
        request.setRemoteAddr("203.0.113.50");
        request.addHeader(GuestAuthenticationFilter.GUEST_WRITE_HEADER, "1");
        request.setCookies(new Cookie(GuestSessionCookie.COOKIE_NAME, guestToken));
        MockHttpServletResponse response = new MockHttpServletResponse();

        try {
            filter.doFilter(request, response, chain);
            return response;
        } finally {
            SecurityContextHolder.clearContext();
        }
    }
}
