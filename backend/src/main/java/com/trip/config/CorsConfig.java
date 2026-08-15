package com.trip.config;

import java.net.URI;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import com.trip.web.auth.AuthCookieAction;
import com.trip.web.auth.GuestAuthenticationFilter;
import com.trip.web.TripStreamController;

/**
 * Exact-origin CORS allowlist. Browser origins come from {@code ALLOWED_ORIGINS}; native
 * WebView origins come from {@code NATIVE_ALLOWED_ORIGINS}. Both are comma-separated,
 * never use wildcards, and never reflect the request {@code Origin} header. If both env
 * vars are unset we fall back to an empty allowlist — preflights from any origin fail
 * safely.
 */
@Configuration
public class CorsConfig {

    private static final List<String> LOCAL_DEV_HOSTS = List.of("localhost", "127.0.0.1", "0.0.0.0");

    @Bean
    public UrlBasedCorsConfigurationSource corsConfigurationSource(AppProperties props,
                                                                   Environment environment) {
        CorsConfiguration cfg = new CorsConfiguration();

        List<String> origins = allowedOrigins(props, environment);
        cfg.setAllowedOrigins(origins);

        // Narrow — only what our REST + SSE surface actually uses.
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        cfg.setAllowedHeaders(List.of(
            "Authorization",
            "Content-Type",
            AuthCookieAction.HEADER,
            GuestAuthenticationFilter.GUEST_WRITE_HEADER,
            TripStreamController.STREAM_CLIENT_HEADER,
            "X-Requested-With",
            "Accept",
            "Origin"
        ));
        cfg.setExposedHeaders(List.of("X-Correlation-Id", "Server-Timing"));
        cfg.setAllowCredentials(true);
        cfg.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
        src.registerCorsConfiguration("/api/**", cfg);
        src.registerCorsConfiguration("/actuator/health/**", healthProbeConfiguration(origins));
        return src;
    }

    private static CorsConfiguration healthProbeConfiguration(List<String> origins) {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(origins);
        cfg.setAllowedMethods(List.of("GET", "OPTIONS"));
        cfg.setAllowedHeaders(List.of("Accept", "Origin"));
        cfg.setAllowCredentials(false);
        cfg.setMaxAge(3600L);
        return cfg;
    }

    static List<String> allowedOrigins(AppProperties props, Environment environment) {
        List<String> configuredBrowserOrigins = configuredOrigins(
            props.getFrontendOrigin(), "ALLOWED_ORIGINS");
        List<String> configuredNativeOrigins = configuredOrigins(
            props.getNativeAllowedOrigins(), "NATIVE_ALLOWED_ORIGINS");

        boolean expandLocalAliases = environment.acceptsProfiles(Profiles.of("local", "dev", "test"));
        Set<String> origins = new LinkedHashSet<>();
        for (String origin : configuredBrowserOrigins) {
            origins.add(origin);
            if (expandLocalAliases) {
                addLocalDevAliases(origins, origin);
            }
        }
        // Native origins are not browser dev hosts: keep them exactly as deployed,
        // including capacitor://localhost on iOS and https://localhost on Android.
        origins.addAll(configuredNativeOrigins);

        return List.copyOf(origins);
    }

    private static List<String> configuredOrigins(String rawOrigins, String variableName) {
        if (rawOrigins == null || rawOrigins.isBlank()) {
            return List.of();
        }
        return Arrays.stream(rawOrigins.split(","))
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .map(origin -> requireExactOrigin(origin, variableName))
            .toList();
    }

    private static String requireExactOrigin(String origin, String variableName) {
        if (origin.contains("*")) {
            throw new IllegalArgumentException(
                variableName + " must contain exact origins; wildcards are not allowed");
        }
        return origin;
    }

    private static void addLocalDevAliases(Set<String> origins, String origin) {
        try {
            URI uri = URI.create(origin);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) {
                return;
            }
            String normalizedHost = host.toLowerCase(Locale.ROOT);
            if (!LOCAL_DEV_HOSTS.contains(normalizedHost)) {
                return;
            }

            for (String aliasHost : LOCAL_DEV_HOSTS) {
                origins.add(originFor(uri, aliasHost));
            }
        } catch (IllegalArgumentException ignored) {
            // Invalid configured origins are left unchanged so Spring rejects them normally.
        }
    }

    private static String originFor(URI uri, String host) {
        StringBuilder origin = new StringBuilder(uri.getScheme()).append("://").append(host);
        if (uri.getPort() >= 0) {
            origin.append(':').append(uri.getPort());
        }
        return origin.toString();
    }
}
