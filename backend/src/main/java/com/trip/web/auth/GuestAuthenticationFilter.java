package com.trip.web.auth;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.regex.Pattern;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.WebUtils;

import com.trip.config.AppProperties;
import com.trip.config.RateLimitFilter;
import com.trip.config.RateLimitRegistry;

import io.github.bucket4j.ConsumptionProbe;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Translates an opaque guest-session cookie into a Spring Security principal.
 *
 * <p>Guest writes require a custom header in addition to SameSite cookies. That
 * protects the cookie-backed guest path from cross-site form/image/script requests
 * without re-enabling Spring's form-oriented CSRF stack for JWT endpoints.
 */
@Component
public class GuestAuthenticationFilter extends OncePerRequestFilter {

    public static final String GUEST_WRITE_HEADER = "X-Dupert-Guest-Write";
    private static final String AUTH_PATH_PREFIX = "/api/auth/";
    private static final Pattern LEGACY_MEMBER_SHARE_ACCEPT_PATH = Pattern.compile(
        "^/api/share/[^/]+/accept$");

    private final RateLimitRegistry rateLimitRegistry;
    private final boolean trustProxy;

    public GuestAuthenticationFilter(RateLimitRegistry rateLimitRegistry, AppProperties appProperties) {
        this.rateLimitRegistry = rateLimitRegistry;
        this.trustProxy = appProperties.isTrustProxy();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {
        if (SecurityContextHolder.getContext().getAuthentication() != null
                || hasBearer(request)) {
            chain.doFilter(request, response);
            return;
        }

        if (isAuthPath(request) || isMemberShareAcceptPath(request)) {
            chain.doFilter(request, response);
            return;
        }

        Cookie cookie = WebUtils.getCookie(request, GuestSessionCookie.COOKIE_NAME);
        if (cookie == null || cookie.getValue() == null || cookie.getValue().isBlank()) {
            chain.doFilter(request, response);
            return;
        }

        String rawToken = cookie.getValue().trim();
        if (requiresGuestWriteProtection(request)) {
            if (!"1".equals(request.getHeader(GUEST_WRITE_HEADER))) {
                writeJson(response, 403, "{\"error\":\"guest_write_header_required\"}", null);
                return;
            }
            if (!consumeGuestWrite(response, request)) {
                return;
            }
        }

        var auth = new UsernamePasswordAuthenticationToken(
            new GuestPrincipal(rawToken), null, List.of());
        SecurityContextHolder.getContext().setAuthentication(auth);
        chain.doFilter(request, response);
    }

    private boolean consumeGuestWrite(HttpServletResponse response,
                                      HttpServletRequest request) throws IOException {
        String clientIp = RateLimitFilter.clientIp(request, trustProxy);
        var bucket = rateLimitRegistry.resolve(RateLimitRegistry.Named.GUEST_WRITE, clientIp);
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            return true;
        }
        long retryAfterSeconds = Math.max(1L, probe.getNanosToWaitForRefill() / 1_000_000_000L);
        writeJson(response, 429, RateLimitFilter.RATE_LIMITED_BODY,
            Long.toString(retryAfterSeconds));
        return false;
    }

    private static boolean hasBearer(HttpServletRequest request) {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        return header != null && header.startsWith("Bearer ");
    }

    private static boolean isAuthPath(HttpServletRequest request) {
        return request.getRequestURI().startsWith(AUTH_PATH_PREFIX);
    }

    private static boolean isMemberShareAcceptPath(HttpServletRequest request) {
        if (!"POST".equals(request.getMethod())) {
            return false;
        }
        String path = request.getRequestURI();
        return "/api/share/accept".equals(path)
            || LEGACY_MEMBER_SHARE_ACCEPT_PATH.matcher(path).matches();
    }

    private static boolean requiresGuestWriteProtection(HttpServletRequest request) {
        if (request.getRequestURI().startsWith("/api/share/")) {
            return false;
        }
        return switch (request.getMethod()) {
            case "POST", "PUT", "PATCH", "DELETE" -> true;
            default -> false;
        };
    }

    private static void writeJson(HttpServletResponse response, int status, String body,
                                  String retryAfterSeconds) throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        if (retryAfterSeconds != null) {
            response.setHeader(HttpHeaders.RETRY_AFTER, retryAfterSeconds);
        }
        response.getWriter().write(body);
    }
}
