package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;
import org.springframework.mock.env.MockEnvironment;

class SecurityDeploymentValidatorTest {

    @Test
    void localDevelopmentOriginDoesNotRequireTransportHardening() {
        AppProperties app = appProperties("http://localhost:3000", false);
        SecureProperties secure = secureProperties(false);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "dev"));

        assertThat(validator.requiresTransportHardening()).isFalse();
    }

    @Test
    void productionProfileRequiresSecureCookiesAndHsts() {
        AppProperties app = appProperties("https://dupert.example", false);
        SecureProperties secure = secureProperties(false);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "prod"));

        assertThat(validator.requiresTransportHardening()).isTrue();
        assertThatThrownBy(() -> validator.run(new DefaultApplicationArguments()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("app.cookies.secure=true")
            .hasMessageContaining("secure.hsts.enabled=true");
    }

    @Test
    void publicFrontendOriginRequiresTransportHardening() {
        AppProperties app = appProperties("https://dupert.example", true);
        app.setTrustProxy(true);
        SecureProperties secure = secureProperties(true);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "staging"));

        assertThat(validator.requiresTransportHardening()).isTrue();
        validator.run(new DefaultApplicationArguments());
    }

    @Test
    void productionProfileRequiresTrustProxy() {
        AppProperties app = appProperties("https://dupert.example", true);
        SecureProperties secure = secureProperties(true);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "prod"));

        assertThatThrownBy(() -> validator.run(new DefaultApplicationArguments()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("app.trust-proxy=true");
    }

    @Test
    void sameSiteNoneRequiresSecureCookies() {
        AppProperties app = appProperties("https://dupert.example", false);
        app.setTrustProxy(true);
        app.getCookies().setSameSite("None");
        SecureProperties secure = secureProperties(true);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "prod"));

        assertThatThrownBy(() -> validator.run(new DefaultApplicationArguments()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("app.cookies.secure=true");
    }

    @Test
    void renderTransportEnvironmentVariablesBindAndSatisfyValidator() {
        StandardEnvironment env = new StandardEnvironment();
        env.getPropertySources().replace(
            StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
            new SystemEnvironmentPropertySource(
                StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                Map.of(
                    "SPRING_PROFILES_ACTIVE", "prod",
                    "APP_COOKIES_SECURE", "true",
                    "SECURE_HSTS_ENABLED", "true",
                    "APP_TRUST_PROXY", "true"
                )));
        ConfigurationPropertySources.attach(env);
        AppProperties app = Binder.get(env).bind("app", AppProperties.class).orElseGet(AppProperties::new);
        SecureProperties secure = Binder.get(env).bind("secure", SecureProperties.class)
            .orElseGet(SecureProperties::new);
        app.setFrontendOrigin("https://dupert.example");
        app.setPublicFrontendUrl("https://dupert.example");
        app.setSignupEnabled(false);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(app, secure, env);

        assertThat(app.getCookies().isSecure()).isTrue();
        assertThat(app.isTrustProxy()).isTrue();
        assertThat(secure.getHsts().isEnabled()).isTrue();
        validator.run(new DefaultApplicationArguments());
    }

    @Test
    void productionLikeDeploymentRejectsWildcardCorsOrigins() {
        AppProperties app = appProperties("*", true);
        app.setTrustProxy(true);
        SecureProperties secure = secureProperties(true);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "staging"));

        assertThatThrownBy(() -> validator.run(new DefaultApplicationArguments()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("wildcards are not allowed");
    }

    @Test
    void productionLikeDeploymentRejectsWildcardNativeCorsOrigins() {
        AppProperties app = appProperties("https://dupert.example", true);
        app.setNativeAllowedOrigins("*");
        app.setTrustProxy(true);
        SecureProperties secure = secureProperties(true);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "staging"));

        assertThatThrownBy(() -> validator.run(new DefaultApplicationArguments()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("NATIVE_ALLOWED_ORIGINS")
            .hasMessageContaining("wildcards are not allowed");
    }

    @Test
    void signupOutsideLocalRequiresEmailConfiguration() {
        AppProperties app = appProperties("https://dupert.example", true);
        app.setTrustProxy(true);
        app.setSignupEnabled(true);
        app.setPublicFrontendUrl("");
        SecureProperties secure = secureProperties(true);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "prod"));

        assertThat(validator.requiresEmailConfig()).isTrue();
        assertThatThrownBy(() -> validator.run(new DefaultApplicationArguments()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("APP_PUBLIC_FRONTEND_URL");
    }

    @Test
    void localProfileDoesNotRequireEmailConfiguration() {
        AppProperties app = appProperties("http://localhost:3000", false);
        app.setSignupEnabled(true);
        SecureProperties secure = secureProperties(false);
        SecurityDeploymentValidator validator = new SecurityDeploymentValidator(
            app, secure, new MockEnvironment().withProperty("spring.profiles.active", "local"));

        assertThat(validator.requiresEmailConfig()).isFalse();
        validator.run(new DefaultApplicationArguments());
    }

    private static AppProperties appProperties(String frontendOrigin, boolean secureCookies) {
        AppProperties app = new AppProperties();
        app.setFrontendOrigin(frontendOrigin);
        app.setPublicFrontendUrl(frontendOrigin);
        app.getCookies().setSecure(secureCookies);
        app.setSignupEnabled(false);
        return app;
    }

    private static SecureProperties secureProperties(boolean hstsEnabled) {
        SecureProperties secure = new SecureProperties();
        secure.getHsts().setEnabled(hstsEnabled);
        return secure;
    }
}
