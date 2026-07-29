package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;

import com.trip.web.auth.AuthCookieAction;
import com.trip.web.auth.GuestAuthenticationFilter;
import com.trip.web.TripStreamController;

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
    void nativeOriginsAreConfiguredExactlyWithoutDevAliasExpansion() {
        AppProperties props = appProperties(
            "https://dupert.vercel.app",
            "capacitor://localhost, https://localhost, capacitor://localhost");
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");

        assertThat(CorsConfig.allowedOrigins(props, environment)).containsExactly(
            "https://dupert.vercel.app",
            "capacitor://localhost",
            "https://localhost");

        var source = new CorsConfig().corsConfigurationSource(props, environment);
        var config = source.getCorsConfiguration(
            new MockHttpServletRequest("OPTIONS", "/api/trips/abc"));

        assertThat(config).isNotNull();
        assertThat(config.checkOrigin("capacitor://localhost")).isEqualTo("capacitor://localhost");
        assertThat(config.checkOrigin("https://localhost")).isEqualTo("https://localhost");
        assertThat(config.checkOrigin("capacitor://localhost.evil")).isNull();
        assertThat(config.checkOrigin("https://127.0.0.1")).isNull();
        assertThat(config.checkHttpMethod(HttpMethod.POST)).contains(HttpMethod.POST);
        assertThat(config.getAllowCredentials()).isTrue();
    }

    @Test
    void rejectsWildcardInEitherConfiguredCorsAllowlist() {
        MockEnvironment environment = new MockEnvironment();

        assertThatThrownBy(() -> CorsConfig.allowedOrigins(
            appProperties("https://dupert.vercel.app", "*"), environment))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("NATIVE_ALLOWED_ORIGINS")
            .hasMessageContaining("wildcards are not allowed");
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
            .contains(
                "Authorization",
                "Content-Type",
                AuthCookieAction.HEADER,
                GuestAuthenticationFilter.GUEST_WRITE_HEADER,
                TripStreamController.STREAM_CLIENT_HEADER);
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
        return appProperties(frontendOrigin, "");
    }

    private static AppProperties appProperties(String frontendOrigin, String nativeAllowedOrigins) {
        AppProperties props = new AppProperties();
        props.setFrontendOrigin(frontendOrigin);
        props.setNativeAllowedOrigins(nativeAllowedOrigins);
        return props;
    }
}
