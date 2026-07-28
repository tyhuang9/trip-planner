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

/**
 * Exact-origin CORS allowlist. The list comes from the {@code ALLOWED_ORIGINS}
 * environment variable (comma-separated); no wildcards, no runtime reflection of the
 * {@code Origin} header. If the env var is unset we fall back to an empty allowlist —
 * preflights from any origin will be rejected, which fails safely.
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
        List<String> configuredOrigins = Arrays.stream(props.getFrontendOrigin().split(","))
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .toList();

        boolean expandLocalAliases = environment.acceptsProfiles(Profiles.of("local", "dev", "test"));
        Set<String> origins = new LinkedHashSet<>();
        for (String origin : configuredOrigins) {
            origins.add(origin);
            if (expandLocalAliases) {
                addLocalDevAliases(origins, origin);
            }
        }

        return List.copyOf(origins);
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
