package com.trip.config;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * Fails closed when a deploy-like environment is missing transport hardening.
 */
@Component
public class SecurityDeploymentValidator implements ApplicationRunner {

    private final AppProperties appProperties;
    private final SecureProperties secureProperties;
    private final Environment environment;

    public SecurityDeploymentValidator(AppProperties appProperties,
                                       SecureProperties secureProperties,
                                       Environment environment) {
        this.appProperties = appProperties;
        this.secureProperties = secureProperties;
        this.environment = environment;
    }

    @Override
    public void run(ApplicationArguments args) {
        boolean publicDeployment = requiresTransportHardening();
        if (publicDeployment) {
            validateCorsOrigins();
            validatePublicFrontendUrl();
            validateTransportHardening();
            validateCookieSameSite();
        }
        if (requiresEmailConfig()) {
            validateEmailConfig();
        }
    }

    boolean requiresTransportHardening() {
        if (environment.acceptsProfiles(Profiles.of("prod"))) {
            return true;
        }
        List<String> origins = configuredBrowserOrigins();
        if (origins.isEmpty()) {
            return false;
        }
        for (String origin : origins) {
            if (!isLocalOrigin(origin)) {
                return true;
            }
        }
        return false;
    }

    private void validateTransportHardening() {
        if (!appProperties.getCookies().isSecure() || !secureProperties.getHsts().isEnabled()) {
            throw new IllegalStateException(
                "Production-like deployments require app.cookies.secure=true and secure.hsts.enabled=true");
        }
        if (!appProperties.isTrustProxy()) {
            throw new IllegalStateException(
                "Production-like deployments require app.trust-proxy=true behind the platform proxy");
        }
    }

    private void validateCorsOrigins() {
        List<String> origins = configuredCorsOrigins();
        boolean hasWildcard = origins.stream().anyMatch(origin -> origin.contains("*"));
        if (hasWildcard) {
            throw new IllegalStateException(
                "Production-like deployments require exact ALLOWED_ORIGINS and NATIVE_ALLOWED_ORIGINS values; wildcards are not allowed");
        }
        if (environment.acceptsProfiles(Profiles.of("prod")) && configuredBrowserOrigins().isEmpty()) {
            throw new IllegalStateException(
                "Production deployments require ALLOWED_ORIGINS to be set to the exact frontend origin");
        }
    }

    private void validatePublicFrontendUrl() {
        if (appProperties.getPublicFrontendUrl().isBlank()) {
            throw new IllegalStateException(
                "Production-like deployments require APP_PUBLIC_FRONTEND_URL for email and share links");
        }
    }

    private void validateCookieSameSite() {
        String sameSite = appProperties.getCookies().getSameSite();
        if (!"Strict".equals(sameSite) && !"Lax".equals(sameSite) && !"None".equals(sameSite)) {
            throw new IllegalStateException(
                "app.cookies.same-site must be Strict, Lax, or None");
        }
        if ("None".equals(sameSite) && !appProperties.getCookies().isSecure()) {
            throw new IllegalStateException(
                "app.cookies.same-site=None requires app.cookies.secure=true");
        }
    }

    boolean requiresEmailConfig() {
        return appProperties.isSignupEnabled()
            && !environment.acceptsProfiles(Profiles.of("local", "test"));
    }

    private void validateEmailConfig() {
        if (appProperties.getPublicFrontendUrl().isBlank()) {
            throw new IllegalStateException(
                "Signup requires APP_PUBLIC_FRONTEND_URL so verification and reset links can be built");
        }
        if (appProperties.getEmail().getBrevoApiKey().isBlank()) {
            throw new IllegalStateException("Signup requires BREVO_API_KEY");
        }
        if (appProperties.getEmail().getFromEmail().isBlank()) {
            throw new IllegalStateException("Signup requires APP_EMAIL_FROM_EMAIL");
        }
    }

    private List<String> configuredBrowserOrigins() {
        return configuredOrigins(appProperties.getFrontendOrigin());
    }

    private List<String> configuredCorsOrigins() {
        List<String> origins = new ArrayList<>(configuredBrowserOrigins());
        origins.addAll(configuredOrigins(appProperties.getNativeAllowedOrigins()));
        return List.copyOf(origins);
    }

    private static List<String> configuredOrigins(String origins) {
        if (origins == null || origins.isBlank()) {
            return List.of();
        }
        return Arrays.stream(origins.split(","))
            .map(String::strip)
            .filter(origin -> !origin.isBlank())
            .toList();
    }

    private static boolean isLocalOrigin(String origin) {
        try {
            URI uri = URI.create(origin);
            String host = uri.getHost();
            if (host == null) {
                return false;
            }
            String normalized = host.toLowerCase(Locale.ROOT);
            return "localhost".equals(normalized)
                || "127.0.0.1".equals(normalized)
                || "::1".equals(normalized);
        } catch (IllegalArgumentException ex) {
            return false;
        }
    }
}
