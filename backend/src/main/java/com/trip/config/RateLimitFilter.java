package com.trip.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import io.github.bucket4j.Bucket;
import io.github.bucket4j.ConsumptionProbe;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Per-endpoint rate-limit enforcement. Activated in chunk 2b for the auth surface.
 *
 * <p>Policies (PROJECT.md §5):
 * <ul>
 *   <li>{@code POST /api/auth/login} — 5 attempts per 15 minutes per remote IP. This is
 *       the <b>outer</b> layer of a two-layer model: the controller adds an inner
 *       per-{@code (ip, normalizedEmail)} bucket (see {@code AuthController.login}),
 *       so a focused attack on one account is rejected by the inner cap while the
 *       outer cap here defeats email-rotation attacks where an attacker churns through
 *       random emails to evade the per-identity cap.</li>
 *   <li>{@code POST /api/auth/register} — 10 per hour per remote IP.</li>
 * </ul>
 *
 * <p>On exhaustion the response is {@code 429 Too Many Requests} with body
 * {@code {"error":"rate_limited"}} and a {@code Retry-After} header in seconds. We
 * write the JSON body manually because the controller advice never gets a chance to
 * run — the filter rejects the request before dispatch. The controller's inner
 * per-identity check emits the identical response shape so a probing attacker can't
 * tell which layer fired from the response alone.
 *
 * <p><b>Why per-IP at this layer.</b> The filter sits ahead of Spring's dispatcher, so
 * reading the request body here would consume the {@link
 * jakarta.servlet.ServletInputStream} and break {@code @RequestBody} downstream.
 * Buffering via {@code ContentCachingRequestWrapper} would add overhead to every
 * request. Instead, the inner per-(ip, email) check runs in the controller after the
 * body is parsed.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RateLimitFilter extends OncePerRequestFilter {

    private static final String LOGIN_PATH = "/api/auth/login";
    private static final String REGISTER_PATH = "/api/auth/register";
    private static final String PASSWORD_RESET_REQUEST_PATH = "/api/auth/password-reset/request";
    private static final String PASSWORD_RESET_CONFIRM_PATH = "/api/auth/password-reset/confirm";
    private static final String EMAIL_VERIFICATION_VERIFY_PATH = "/api/auth/email/verify";
    private static final String EMAIL_VERIFICATION_RESEND_PATH = "/api/auth/email/resend";
    private static final String REFRESH_PATH = "/api/auth/refresh";
    private static final String LOGOUT_PATH = "/api/auth/logout";
    private static final String DEV_LOGIN_AS_PATH = "/api/dev/auth/login-as";
    private static final String DEV_USERS_PATH = "/api/dev/users";
    private static final String DEV_USERS_RESEED_PATH = "/api/dev/users/reseed";
    private static final String SHARE_PATH_PREFIX = "/api/share/";
    private static final String PLACES_PATH_PREFIX = "/api/places/";
    private static final String MAPS_PATH_PREFIX = "/api/maps/";
    private static final String HEALTH_PATH = "/actuator/health";
    private static final String DATABASE_HEALTH_PATH = HEALTH_PATH + "/database";
    private static final String DB_INDICATOR_HEALTH_PATH = HEALTH_PATH + "/db";
    /**
     * Shared with {@code AuthController}'s inner per-(ip, email) check so the two
     * layers emit byte-identical 429 bodies — a probing attacker cannot distinguish
     * "outer per-IP cap fired" from "inner per-identity cap fired".
     */
    public static final String RATE_LIMITED_BODY = "{\"error\":\"rate_limited\"}";

    private final RateLimitRegistry registry;
    private final boolean trustProxy;

    public RateLimitFilter(RateLimitRegistry registry, AppProperties appProperties) {
        this.registry = registry;
        this.trustProxy = appProperties.isTrustProxy();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        String clientIp = clientIp(request, trustProxy);
        if (isDatabaseHealthPath(path) && "GET".equalsIgnoreCase(request.getMethod())) {
            if (!tryConsume(response, RateLimitRegistry.Named.HEALTH_DATABASE, clientIp)) {
                return;
            }
        }
        if (isGoogleMapsProxyPath(path)
            && ("GET".equalsIgnoreCase(request.getMethod()) || "POST".equalsIgnoreCase(request.getMethod()))) {
            if (!tryConsume(response, RateLimitRegistry.Named.GOOGLE_MAPS, clientIp)) {
                return;
            }
        }
        if ("POST".equalsIgnoreCase(request.getMethod())) {
            if (LOGIN_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_LOGIN, clientIp)) {
                    return;
                }
            } else if (REGISTER_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_REGISTER, clientIp)) {
                    return;
                }
            } else if (PASSWORD_RESET_REQUEST_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_PASSWORD_RESET_REQUEST, clientIp)) {
                    return;
                }
            } else if (PASSWORD_RESET_CONFIRM_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_PASSWORD_RESET_CONFIRM, clientIp)) {
                    return;
                }
            } else if (EMAIL_VERIFICATION_VERIFY_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_EMAIL_VERIFICATION_VERIFY, clientIp)) {
                    return;
                }
            } else if (EMAIL_VERIFICATION_RESEND_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_EMAIL_VERIFICATION_RESEND, clientIp)) {
                    return;
                }
            } else if (REFRESH_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_REFRESH, clientIp)) {
                    return;
                }
            } else if (LOGOUT_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_LOGOUT, clientIp)) {
                    return;
                }
            } else if (DEV_LOGIN_AS_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_DEV_LOGIN_AS, clientIp)) {
                    return;
                }
            } else if (DEV_USERS_PATH.equals(path) || DEV_USERS_RESEED_PATH.equals(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.AUTH_DEV_USERS, clientIp)) {
                    return;
                }
            } else if (isShareAcceptPath(path)) {
                if (!tryConsume(response, RateLimitRegistry.Named.SHARE_ACCEPT, clientIp)) {
                    return;
                }
            }
        }
        chain.doFilter(request, response);
    }

    private static boolean isGoogleMapsProxyPath(String path) {
        return path.startsWith(PLACES_PATH_PREFIX) || path.startsWith(MAPS_PATH_PREFIX);
    }

    private static boolean isDatabaseHealthPath(String path) {
        return HEALTH_PATH.equals(path)
            || isPathOrDescendant(path, DATABASE_HEALTH_PATH)
            || isPathOrDescendant(path, DB_INDICATOR_HEALTH_PATH);
    }

    private static boolean isPathOrDescendant(String path, String root) {
        return root.equals(path) || path.startsWith(root + "/");
    }

    private static boolean isShareAcceptPath(String path) {
        if (!path.startsWith(SHARE_PATH_PREFIX)) {
            return false;
        }
        int tokenStart = SHARE_PATH_PREFIX.length();
        int tokenEnd = path.indexOf('/', tokenStart);
        if (tokenEnd <= tokenStart || tokenEnd == path.length() - 1) {
            return false;
        }
        String action = path.substring(tokenEnd + 1);
        return "accept".equals(action) || "guest".equals(action);
    }

    private boolean tryConsume(HttpServletResponse response,
                               RateLimitRegistry.Named bucketName,
                               String discriminator) throws IOException {
        Bucket bucket = registry.resolve(bucketName, discriminator);
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            return true;
        }
        long retryAfterSeconds = Math.max(1L, probe.getNanosToWaitForRefill() / 1_000_000_000L);
        // Jakarta's HttpServletResponse doesn't expose SC_TOO_MANY_REQUESTS; use the
        // numeric status code directly.
        response.setStatus(429);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setHeader(HttpHeaders.RETRY_AFTER, Long.toString(retryAfterSeconds));
        response.getWriter().write(RATE_LIMITED_BODY);
        return false;
    }

    /**
     * Best-effort client IP. Honors the first entry of {@code X-Forwarded-For} only
     * when {@code app.trust-proxy} is enabled — otherwise the header is fully ignored
     * and we use the socket-level remote address. Without this gate a directly-exposed
     * deployment would let any caller spoof their rate-limit key by setting the
     * header. Server operators MUST configure upstream proxies to overwrite (not
     * append) this header before flipping the flag — Fly's edge does this by default;
     * Vercel does as well.
     *
     * <p>Public so {@code AuthController} (the inner per-(ip, email) layer) and
     * {@code RateLimitFilterTest} can both drive the resolver directly without
     * spinning up a filter chain.
     */
    public static String clientIp(HttpServletRequest request, boolean trustProxy) {
        if (trustProxy) {
            String forwarded = request.getHeader("X-Forwarded-For");
            if (forwarded != null && !forwarded.isBlank()) {
                int comma = forwarded.indexOf(',');
                String first = comma < 0 ? forwarded : forwarded.substring(0, comma);
                return first.trim();
            }
        }
        return request.getRemoteAddr();
    }
}
