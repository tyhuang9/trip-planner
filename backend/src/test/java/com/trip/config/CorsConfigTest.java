package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;

import com.trip.web.auth.AuthCookieAction;
import com.trip.web.auth.GuestAuthenticationFilter;

class CorsConfigTest {

    @Test
    void devExpandsLocalhostToLoopbackAlias() {
        AppProperties props = appProperties("http://localhost:3000");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        assertThat(CorsConfig.allowedOrigins(props, environment))
            .containsExactly(
                "http://localhost:3000",
                "http://127.0.0.1:3000",
                "http://0.0.0.0:3000");
    }

    @Test
    void devExpandsLoopbackAliasToLocalhost() {
        AppProperties props = appProperties("http://127.0.0.1:3000");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        assertThat(CorsConfig.allowedOrigins(props, environment))
            .containsExactly(
                "http://127.0.0.1:3000",
                "http://localhost:3000",
                "http://0.0.0.0:3000");
    }

    @Test
    void devExpandsWildcardBindAddressToBrowserLoopbackAliases() {
        AppProperties props = appProperties("http://0.0.0.0:3000");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        assertThat(CorsConfig.allowedOrigins(props, environment))
            .containsExactly(
                "http://0.0.0.0:3000",
                "http://localhost:3000",
                "http://127.0.0.1:3000");
    }

    @Test
    void prodKeepsExactConfiguredOriginsOnly() {
        AppProperties props = appProperties("http://localhost:3000");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("prod");

        assertThat(CorsConfig.allowedOrigins(props, environment))
            .containsExactly("http://localhost:3000");
    }

    @Test
    void nonLocalOriginsAreNeverExpanded() {
        AppProperties props = appProperties("https://dupert.example");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        assertThat(CorsConfig.allowedOrigins(props, environment))
            .containsExactly("https://dupert.example");
    }

    @Test
    void configuredCommaSeparatedOriginsArePreservedAndDeduped() {
        AppProperties props = appProperties(
            "http://localhost:3000, http://127.0.0.1:3000, https://dupert.example");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        assertThat(CorsConfig.allowedOrigins(props, environment))
            .isEqualTo(List.of(
                "http://localhost:3000",
                "http://127.0.0.1:3000",
                "http://0.0.0.0:3000",
                "https://dupert.example"));
    }

    @Test
    void corsAllowsGuestAndAuthCookieActionHeadersAndExposesTiming() {
        AppProperties props = appProperties("http://localhost:3000");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        var source = new CorsConfig().corsConfigurationSource(props, environment);
        var config = source.getCorsConfiguration(
            new MockHttpServletRequest("OPTIONS", "/api/trips/abc"));

        assertThat(config).isNotNull();
        assertThat(config.getAllowedHeaders())
            .contains(AuthCookieAction.HEADER, GuestAuthenticationFilter.GUEST_WRITE_HEADER);
        assertThat(config.getExposedHeaders())
            .contains("X-Correlation-Id", "Server-Timing");
    }

    @Test
    void healthProbeCorsDoesNotEnableCredentials() {
        AppProperties props = appProperties("http://localhost:3000");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        var source = new CorsConfig().corsConfigurationSource(props, environment);
        var config = source.getCorsConfiguration(
            new MockHttpServletRequest("OPTIONS", "/actuator/health/liveness"));

        assertThat(config).isNotNull();
        assertThat(config.getAllowedMethods()).containsExactly("GET", "OPTIONS");
        assertThat(config.getAllowCredentials()).isFalse();
    }

    private static AppProperties appProperties(String frontendOrigin) {
        AppProperties props = new AppProperties();
        props.setFrontendOrigin(frontendOrigin);
        return props;
    }
}
