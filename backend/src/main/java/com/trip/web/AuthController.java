package com.trip.web;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.WebUtils;

import com.trip.config.AppProperties;
import com.trip.config.RateLimitFilter;
import com.trip.config.RateLimitRegistry;
import com.trip.domain.User;
import com.trip.observability.AccountDeletionMetrics;
import com.trip.observability.AccountDeletionMetrics.Outcome;
import com.trip.repo.UserRepository;
import com.trip.service.auth.AccountService;
import com.trip.service.auth.AccountService.DeleteAccountResult;
import com.trip.service.auth.AuthTokenService;
import com.trip.service.auth.EmailNormalizer;
import com.trip.service.auth.EmailVerificationOperations;
import com.trip.service.auth.JwtService;
import com.trip.service.auth.PasswordResetService;
import com.trip.service.auth.RefreshTokenService;
import com.trip.service.auth.RefreshTokenService.IssuedRefreshToken;
import com.trip.service.auth.SafeReturnPath;
import com.trip.web.auth.AuthCookieAction;
import com.trip.web.auth.DisplayNameSanitizer;
import com.trip.web.auth.RefreshCookie;
import com.trip.web.dto.AuthResponse;
import com.trip.web.dto.ChangePasswordRequest;
import com.trip.web.dto.DeleteAccountRequest;
import com.trip.web.dto.EmailVerificationRequest;
import com.trip.web.dto.EmailVerificationResendRequest;
import com.trip.web.dto.LoginRequest;
import com.trip.web.dto.PasswordResetConfirmRequest;
import com.trip.web.dto.PasswordResetRequest;
import com.trip.web.dto.RegisterRequest;
import com.trip.web.dto.RegisterResponse;
import com.trip.web.dto.UpdateProfileRequest;
import com.trip.web.dto.UserSummary;

import io.github.bucket4j.Bucket;
import io.github.bucket4j.ConsumptionProbe;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;

/**
 * Auth endpoint surface: register, login, refresh, logout, me (get + delete).
 *
 * <p>Two security invariants live here:
 * <ul>
 *   <li><b>Anti-enumeration on login.</b> Whether or not the email exists, we always run
 *       bcrypt against <em>some</em> hash so wall-clock timing is uniform; success and
 *       failure responses share the same status (401) and body
 *       ({@code {"error":"invalid_credentials"}}).</li>
 *   <li><b>Generic failure responses.</b> Refresh, logout, and delete-me never reveal
 *       whether the token was missing, malformed, expired, or revoked — every failure
 *       returns the same shape ({@code {"error":"unauthenticated"}} for 401; 204 for
 *       logout regardless). The raw refresh token never appears in any logger output,
 *       including DEBUG.</li>
 * </ul>
 *
 * <p>Length watch: this controller is borderline. If a future chunk pushes it past ~250
 * non-blank lines, split me/delete into a separate {@code AccountController}.
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private static final Logger log = LoggerFactory.getLogger(AuthController.class);

    private static final String UNAUTHENTICATED_BODY_KEY = "error";
    private static final String UNAUTHENTICATED_BODY_VALUE = "unauthenticated";

    /**
     * Static dummy bcrypt hash used to keep login wall-clock time uniform when the
     * submitted email doesn't exist. Computed once at construction time so the cost is
     * identical to a real verify against any registered user.
     */
    private final String dummyHash;

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final RefreshTokenService refreshTokenService;
    private final RefreshCookie refreshCookie;
    private final AuthTokenService authTokenService;
    private final AccountService accountService;
    private final AccountDeletionMetrics accountDeletionMetrics;
    private final PasswordResetService passwordResetService;
    private final EmailVerificationOperations emailVerificationService;
    private final RateLimitRegistry rateLimitRegistry;
    private final boolean trustProxy;
    private final boolean localProfile;
    private final boolean signupEnabled;

    public AuthController(UserRepository userRepository,
                          PasswordEncoder passwordEncoder,
                          JwtService jwtService,
                          RefreshTokenService refreshTokenService,
                          RefreshCookie refreshCookie,
                          AuthTokenService authTokenService,
                          AccountService accountService,
                          AccountDeletionMetrics accountDeletionMetrics,
                          PasswordResetService passwordResetService,
                          EmailVerificationOperations emailVerificationService,
                          RateLimitRegistry rateLimitRegistry,
                          AppProperties appProperties,
                          Environment environment) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.refreshTokenService = refreshTokenService;
        this.refreshCookie = refreshCookie;
        this.authTokenService = authTokenService;
        this.accountService = accountService;
        this.accountDeletionMetrics = accountDeletionMetrics;
        this.passwordResetService = passwordResetService;
        this.emailVerificationService = emailVerificationService;
        this.rateLimitRegistry = rateLimitRegistry;
        this.trustProxy = appProperties.isTrustProxy();
        this.localProfile = environment.acceptsProfiles(Profiles.of("local"));
        this.signupEnabled = appProperties.isSignupEnabled();
        this.dummyHash = passwordEncoder.encode("dummy-password-for-anti-enumeration");
    }

    @PostMapping("/register")
    public ResponseEntity<?> register(@Valid @RequestBody RegisterRequest body) {
        if (!signupEnabled) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("error", "signup_disabled"));
        }

        String email = EmailNormalizer.normalize(body.email());
        String displayName = DisplayNameSanitizer.sanitize(body.displayName());

        if (displayName == null || displayName.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(Map.of("error", "invalid_display_name"));
        }

        if (userRepository.existsByEmailIgnoreCase(email)) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(Map.of("error", "email_taken"));
        }

        String passwordHash = passwordEncoder.encode(body.password());
        User user = new User(email, passwordHash, displayName);
        if (localProfile) {
            user.markEmailVerified(OffsetDateTime.now());
        }
        User saved = userRepository.save(user);

        if (localProfile) {
            return ResponseEntity.status(HttpStatus.CREATED)
                .body(new RegisterResponse("verified", saved.getEmail()));
        }

        try {
            emailVerificationService.queueInitialVerification(
                saved.getId(), SafeReturnPath.normalize(body.returnPath()));
        } catch (RuntimeException e) {
            log.warn("Initial email verification enqueue failed userId={} exception={} token=<redacted>",
                saved.getId(), e.getClass().getSimpleName());
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED)
            .body(new RegisterResponse("verification_required", saved.getEmail()));
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@Valid @RequestBody LoginRequest body,
                                   HttpServletRequest request,
                                   HttpServletResponse response) {
        String email = EmailNormalizer.normalize(body.email());

        // Inner per-(ip, email) rate-limit layer. Consumed BEFORE the user lookup and
        // bcrypt for two reasons: (1) the cap must apply to unknown emails too, or a
        // credential-stuffing attacker probing nonexistent accounts gets unlimited
        // attempts; (2) consuming after bcrypt would leak email existence by timing.
        // The outer per-IP filter is still in front; both must have capacity.
        ResponseEntity<?> limited = enforcePerIdentityLimit(request, email);
        if (limited != null) {
            return limited;
        }

        var maybeUser = userRepository.findByEmailIgnoreCase(email);

        // Always run bcrypt — against the real hash if the user exists, otherwise the
        // dummy. matches() is O(2^cost) bcrypt work, so this keeps timing uniform.
        String hashToCompare = maybeUser.map(User::getPasswordHash).orElse(dummyHash);
        boolean matches = passwordEncoder.matches(body.password(), hashToCompare);

        if (maybeUser.isEmpty() || !matches) {
            // Identical response shape for "no such email" and "wrong password" — the
            // single load-bearing anti-enumeration guarantee for this endpoint.
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", "invalid_credentials"));
        }

        User user = maybeUser.get();
        if (!user.isEmailVerified()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("error", "email_unverified"));
        }

        return ResponseEntity.ok(authTokenService.issueTokens(user, response));
    }

    /**
     * Tries to consume one token from the per-{@code (ip, normalizedEmail)} bucket.
     * Returns {@code null} on success (caller proceeds), or a fully-built 429
     * {@link ResponseEntity} matching {@link RateLimitFilter}'s outer-layer body and
     * {@code Retry-After} header on exhaustion. Indistinguishability between the two
     * layers is the load-bearing invariant — same status, same body, same header.
     */
    private ResponseEntity<?> enforcePerIdentityLimit(HttpServletRequest request, String normalizedEmail) {
        String ip = RateLimitFilter.clientIp(request, trustProxy);
        String discriminator = ip + ":" + normalizedEmail;
        Bucket bucket = rateLimitRegistry.resolve(
            RateLimitRegistry.Named.AUTH_LOGIN_PER_IDENTITY, discriminator);
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            return null;
        }
        long retryAfterSeconds = Math.max(1L, probe.getNanosToWaitForRefill() / 1_000_000_000L);
        return ResponseEntity.status(429)
            .header(HttpHeaders.RETRY_AFTER, Long.toString(retryAfterSeconds))
            .contentType(MediaType.APPLICATION_JSON)
            .body(Map.of("error", "rate_limited"));
    }

    /**
     * Rotates the refresh cookie and returns a new access token.
     *
     * <p>Failure modes — missing cookie, unknown token, revoked token (reuse signal),
     * expired token, deleted user — all return the same generic 401 and clear the cookie.
     * Differentiating would leak information about token state to a probing attacker.
     */
    @PostMapping("/refresh")
    public ResponseEntity<?> refresh(HttpServletRequest request, HttpServletResponse response) {
        if (!AuthCookieAction.isPresent(request)) {
            return authCookieHeaderRequired();
        }
        Cookie cookie = WebUtils.getCookie(request, RefreshCookie.COOKIE_NAME);
        if (cookie == null || cookie.getValue() == null || cookie.getValue().isEmpty()) {
            refreshCookie.clearOnResponse(response);
            return unauthenticated();
        }

        Optional<IssuedRefreshToken> rotated = refreshTokenService.rotate(cookie.getValue());
        if (rotated.isEmpty()) {
            // Empty covers: unknown hash, revoked (chain already revoked by rotate),
            // and expired. All look the same to the caller.
            refreshCookie.clearOnResponse(response);
            return unauthenticated();
        }

        IssuedRefreshToken next = rotated.get();
        Optional<User> maybeUser = userRepository.findById(next.entity().getUserId());
        if (maybeUser.isEmpty()) {
            // Race: user was deleted between the rotate() commit and the lookup. Revoke
            // the just-issued refresh so it can never be used, then 401 the caller.
            refreshTokenService.revokeAllForUser(next.entity().getUserId());
            refreshCookie.clearOnResponse(response);
            return unauthenticated();
        }

        // Set the new refresh cookie and return the new access token.
        refreshCookie.addToResponse(response, next.rawToken());
        String accessToken = jwtService.issueAccessToken(maybeUser.get().getId());
        return ResponseEntity.ok(authTokenService.buildAuthResponse(maybeUser.get(), accessToken));
    }

    /**
     * Revokes the presented refresh token (if any) and clears the cookie. Always returns
     * 204; we don't tell the caller whether the token was valid, missing, or already
     * revoked. Idempotent.
     */
    @PostMapping("/logout")
    public ResponseEntity<Void> logout(HttpServletRequest request, HttpServletResponse response) {
        if (!AuthCookieAction.isPresent(request)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Cookie cookie = WebUtils.getCookie(request, RefreshCookie.COOKIE_NAME);
        if (cookie != null && cookie.getValue() != null && !cookie.getValue().isEmpty()) {
            // No-op for unknown/already-revoked tokens; revokeByRawToken handles those.
            refreshTokenService.revokeByRawToken(cookie.getValue());
        }
        refreshCookie.clearOnResponse(response);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/password-reset/request")
    public ResponseEntity<?> requestPasswordReset(@Valid @RequestBody PasswordResetRequest body,
                                                  HttpServletRequest request) {
        String email = EmailNormalizer.normalize(body.email());
        ResponseEntity<?> limited = enforcePasswordResetRequestLimit(request, email);
        if (limited != null) {
            return limited;
        }

        passwordResetService.requestReset(email);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/password-reset/confirm")
    public ResponseEntity<Void> confirmPasswordReset(
            @Valid @RequestBody PasswordResetConfirmRequest body) {
        passwordResetService.confirmReset(body.token(), body.password());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/email/verify")
    public ResponseEntity<AuthResponse> verifyEmail(
            @Valid @RequestBody EmailVerificationRequest body,
            HttpServletResponse response) {
        User user = emailVerificationService.verify(body.token());
        return ResponseEntity.ok(authTokenService.issueTokens(user, response));
    }

    @PostMapping("/email/resend")
    public ResponseEntity<?> resendEmailVerification(
            @Valid @RequestBody EmailVerificationResendRequest body,
            HttpServletRequest request) {
        String email = EmailNormalizer.normalize(body.email());
        ResponseEntity<?> limited = enforceEmailVerificationResendLimit(request, email);
        if (limited != null) {
            return limited;
        }

        emailVerificationService.resend(email, SafeReturnPath.normalize(body.returnPath()));
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/me")
    public ResponseEntity<?> me(Authentication authentication) {
        Long userId = principalUserId(authentication);
        if (userId == null) {
            // The route is "authenticated" per SecurityConfig, so reaching here without a
            // principal would mean Spring Security let the request through with no auth.
            // Defense in depth — return the same generic 401.
            return unauthenticated();
        }
        Optional<User> maybeUser = userRepository.findById(userId);
        if (maybeUser.isEmpty()) {
            // Deleted account whose access token hasn't expired yet.
            return unauthenticated();
        }
        User user = maybeUser.get();
        return ResponseEntity.ok(UserSummary.from(user));
    }

    @PatchMapping("/me/profile")
    public ResponseEntity<?> updateProfile(@Valid @RequestBody UpdateProfileRequest body,
                                           Authentication authentication) {
        Long userId = principalUserId(authentication);
        if (userId == null) {
            return unauthenticated();
        }
        return accountService.updateProfile(userId, body.displayName())
            .<ResponseEntity<?>>map(ResponseEntity::ok)
            .orElseGet(AuthController::unauthenticated);
    }

    @PostMapping("/me/password")
    public ResponseEntity<?> changePassword(@Valid @RequestBody ChangePasswordRequest body,
                                            Authentication authentication) {
        Long userId = principalUserId(authentication);
        if (userId == null) {
            return unauthenticated();
        }
        if (!accountService.changePassword(userId, body.currentPassword(), body.newPassword())) {
            return unauthenticated();
        }
        return ResponseEntity.noContent().build();
    }

    /**
     * Hard-deletes the calling user's account.
     *
     * <p>The service preserves owned trips that still have another registered member by
     * transferring ownership, and deletes owned trips that would otherwise become
     * orphaned. The current password is verified before any destructive side effect.
     * Refresh tokens are then revoked before the user row is deleted. That blocks later
     * refresh attempts, but cannot retract a response that was already in flight; clients
     * must serialize deletion with refresh and discard stale refresh results.
     */
    @DeleteMapping("/me")
    public ResponseEntity<?> deleteMe(@Valid @RequestBody DeleteAccountRequest body,
                                      Authentication authentication,
                                      HttpServletResponse response) {
        Long userId = principalUserId(authentication);
        if (userId == null) {
            return unauthenticated();
        }

        ResponseEntity<?> limited = enforceAccountDeleteLimit(userId);
        if (limited != null) {
            accountDeletionMetrics.record(Outcome.USER_THROTTLED);
            return limited;
        }

        DeleteAccountResult result;
        try {
            result = accountService.deleteAccount(userId, body.currentPassword());
        } catch (RuntimeException exception) {
            accountDeletionMetrics.record(Outcome.TRANSACTION_FAILED);
            throw exception;
        }
        return switch (result) {
            case DELETED -> {
                accountDeletionMetrics.record(Outcome.SUCCESS);
                refreshCookie.clearOnResponse(response);
                yield ResponseEntity.noContent().build();
            }
            case USER_NOT_FOUND -> {
                accountDeletionMetrics.record(Outcome.USER_MISSING);
                yield unauthenticated();
            }
            case REAUTHENTICATION_FAILED -> {
                accountDeletionMetrics.record(Outcome.FRESH_AUTH_REJECTED);
                yield ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("error", "reauthentication_failed"));
            }
        };
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static ResponseEntity<?> unauthenticated() {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
            .body(Map.of(UNAUTHENTICATED_BODY_KEY, UNAUTHENTICATED_BODY_VALUE));
    }

    private static ResponseEntity<?> authCookieHeaderRequired() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
            .body(Map.of("error", "auth_cookie_header_required"));
    }

    private ResponseEntity<?> enforceAccountDeleteLimit(Long userId) {
        Bucket bucket = rateLimitRegistry.resolve(
            RateLimitRegistry.Named.AUTH_ACCOUNT_DELETE_PER_USER, userId.toString());
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            return null;
        }
        long retryAfterSeconds = Math.max(1L, probe.getNanosToWaitForRefill() / 1_000_000_000L);
        return ResponseEntity.status(429)
            .header(HttpHeaders.RETRY_AFTER, Long.toString(retryAfterSeconds))
            .contentType(MediaType.APPLICATION_JSON)
            .body(Map.of("error", "rate_limited"));
    }

    private ResponseEntity<?> enforcePasswordResetRequestLimit(HttpServletRequest request,
                                                               String normalizedEmail) {
        String ip = RateLimitFilter.clientIp(request, trustProxy);
        String discriminator = ip + ":" + normalizedEmail;
        Bucket bucket = rateLimitRegistry.resolve(
            RateLimitRegistry.Named.AUTH_PASSWORD_RESET_REQUEST_PER_EMAIL, discriminator);
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            return null;
        }
        long retryAfterSeconds = Math.max(1L, probe.getNanosToWaitForRefill() / 1_000_000_000L);
        return ResponseEntity.status(429)
            .header(HttpHeaders.RETRY_AFTER, Long.toString(retryAfterSeconds))
            .contentType(MediaType.APPLICATION_JSON)
            .body(Map.of("error", "rate_limited"));
    }

    private ResponseEntity<?> enforceEmailVerificationResendLimit(HttpServletRequest request,
                                                                  String normalizedEmail) {
        String ip = RateLimitFilter.clientIp(request, trustProxy);
        String discriminator = ip + ":" + normalizedEmail;
        Bucket bucket = rateLimitRegistry.resolve(
            RateLimitRegistry.Named.AUTH_EMAIL_VERIFICATION_RESEND_PER_EMAIL, discriminator);
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            return null;
        }
        long retryAfterSeconds = Math.max(1L, probe.getNanosToWaitForRefill() / 1_000_000_000L);
        return ResponseEntity.status(429)
            .header(HttpHeaders.RETRY_AFTER, Long.toString(retryAfterSeconds))
            .contentType(MediaType.APPLICATION_JSON)
            .body(Map.of("error", "rate_limited"));
    }

    /**
     * Extracts the user id from the {@link Authentication} principal installed by
     * {@link com.trip.web.auth.JwtAuthenticationFilter}. Returns null for any unexpected
     * shape (no authentication, anonymous, non-Long principal) so callers can return a
     * generic 401 instead of throwing.
     */
    private static Long principalUserId(Authentication authentication) {
        if (authentication == null || !authentication.isAuthenticated()) {
            return null;
        }
        Object principal = authentication.getPrincipal();
        if (principal instanceof Long id) {
            return id;
        }
        return null;
    }

}
