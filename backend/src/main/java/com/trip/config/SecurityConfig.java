package com.trip.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import com.trip.web.auth.JwtAuthenticationFilter;
import com.trip.web.auth.GuestAuthenticationFilter;

import org.springframework.http.HttpStatus;

/**
 * Baseline Spring Security configuration.
 *
 * <p>Design notes:
 * <ul>
 *   <li>Stateless — no HTTP session, no login form, no {@code JSESSIONID}. All
 *       authentication is JWT (via {@link JwtAuthenticationFilter}) for users; guest
 *       sessions land in Piece 5.</li>
 *   <li>CSRF disabled — the API is token-driven and cookies for guest sessions carry
 *       a {@code SameSite} attribute plus a required custom header. Piece 5 will add
 *       the custom-header check as a dedicated filter, not by re-enabling Spring's
 *       HTML-form CSRF.</li>
 *   <li>Public endpoints are enumerated explicitly: register / login / refresh / logout
 *       all stay public because they either lack a bearer (refresh, logout) or are the
 *       very thing minting one (register, login). {@code /api/auth/me} (GET and DELETE)
 *       requires a valid bearer; the {@code JwtAuthenticationFilter} translates that
 *       bearer into a {@code SecurityContext} principal.</li>
 * </ul>
 */
@Configuration
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http,
                                           UrlBasedCorsConfigurationSource corsSource,
                                           JwtAuthenticationFilter jwtAuthFilter,
                                           GuestAuthenticationFilter guestAuthenticationFilter,
                                           Environment environment)
            throws Exception {
        boolean localProfile = environment.acceptsProfiles(Profiles.of("local"));

        http
            .cors(cors -> cors.configurationSource(corsSource))
            .csrf(AbstractHttpConfigurer::disable)
            .formLogin(AbstractHttpConfigurer::disable)
            .httpBasic(AbstractHttpConfigurer::disable)
            .logout(AbstractHttpConfigurer::disable)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            // Run the JWT translator before the username/password filter slot so a valid
            // bearer becomes the request's authentication before authorization runs.
            .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
            .addFilterAfter(guestAuthenticationFilter, JwtAuthenticationFilter.class)
            // The OncePerRequestFilters (headers, CSP, correlation id, rate-limit) are
            // picked up automatically because they're @Component + @Order annotated.
            .exceptionHandling(ex -> ex
                .authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
            .authorizeHttpRequests(auth -> {
                auth.requestMatchers("/actuator/health").permitAll();
                auth.requestMatchers("/actuator/health/**").permitAll();
                auth.requestMatchers("/error").permitAll();
                // Auth surface — split intentionally. register/login/refresh/logout
                // never carry a bearer (refresh and logout rely on the refresh cookie;
                // register and login mint the first bearer). /api/auth/me requires the
                // bearer the client just received.
                auth.requestMatchers(HttpMethod.POST, "/api/auth/register").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/auth/login").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/auth/password-reset/request").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/auth/password-reset/confirm").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/auth/email/verify").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/auth/email/resend").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/auth/refresh").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/auth/logout").permitAll();
                if (localProfile) {
                    auth.requestMatchers("/api/dev/**").permitAll();
                }
                auth.requestMatchers("/api/auth/me").authenticated();
                // Cookie-only guest launch probe. Missing and inactive credentials
                // intentionally reach the controller and collapse to a uniform 204.
                auth.requestMatchers(HttpMethod.GET, "/api/guest-session/bootstrap").permitAll();
                // Guest share acceptance is public. Member acceptance requires a
                // bearer; legacy token-in-path clients retain the same route behavior.
                auth.requestMatchers(HttpMethod.POST, "/api/share/guest").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/share/*/guest").permitAll();
                auth.requestMatchers(HttpMethod.POST, "/api/share/accept").authenticated();
                auth.requestMatchers(HttpMethod.POST, "/api/share/*/accept").authenticated();
                // Everything else under /api/** requires a valid bearer.
                auth.requestMatchers("/api/**").authenticated();
                // Non-/api paths (static assets, etc.) are not served by this backend,
                // but we deny-by-default as a belt-and-suspenders measure.
                auth.anyRequest().denyAll();
            });

        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        // bcrypt with cost 12 per §5 of the plan; Piece 2 uses this when registering users.
        return new BCryptPasswordEncoder(12);
    }
}
