package com.trip.service.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.trip.domain.RefreshToken;
import com.trip.domain.User;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.RefreshTokenRepository.TokenObservation;
import com.trip.repo.UserRepository;

/**
 * Owns the lifecycle of opaque refresh tokens: minting, hashing, validating, rotating,
 * and revoking.
 *
 * <p><b>Storage format.</b> Raw tokens are 32 random bytes from {@link SecureRandom},
 * base64url-encoded without padding (~43 chars). Only the SHA-256 digest is persisted,
 * encoded as <b>lowercase hex</b> in {@code refresh_tokens.token_hash} (matches the
 * {@code VARCHAR(64)} width and unique index in V1).
 *
 * <p><b>Rotation chain &amp; reuse detection.</b> The V1 schema does not have a
 * {@code family_id} column. Instead, every rotation links the old row to the new via
 * {@code replaced_by}. Walking that pointer in both directions reconstructs the chain on
 * the fly, which is enough to revoke the whole family if a revoked node is ever
 * presented again — the canonical "refresh-token theft detected" signal.
 *
 * <p><b>Note on user-agent/IP.</b> The Piece-1 {@link RefreshToken} entity does not have
 * {@code user_agent} or {@code ip} columns. The chunk-2a spec allows dropping those
 * parameters in that case, so the public methods here intentionally omit them; 2b/2c
 * can add them when (and if) a V2 migration introduces the columns.
 *
 */
@Service
public class RefreshTokenService {

    static final Duration REFRESH_TOKEN_TTL = Duration.ofDays(30);
    private static final int RAW_TOKEN_BYTES = 32;

    private final RefreshTokenRepository repo;
    private final UserRepository userRepository;
    private final SecureRandom random;

    @Autowired
    public RefreshTokenService(RefreshTokenRepository repo, UserRepository userRepository) {
        this(repo, userRepository, new SecureRandom());
    }

    /** Test seam — lets unit tests inject a deterministic random source. */
    RefreshTokenService(RefreshTokenRepository repo,
                        UserRepository userRepository,
                        SecureRandom random) {
        this.repo = repo;
        this.userRepository = userRepository;
        this.random = random;
    }

    /**
     * Tuple returned to callers that mint a token: the raw string is the only thing the
     * client ever sees (it goes into the refresh cookie), the entity is the persisted
     * row.
     */
    public record IssuedRefreshToken(String rawToken, RefreshToken entity) {}

    @Transactional
    public IssuedRefreshToken issueFor(User user) {
        return mint(user.getId(), OffsetDateTime.now());
    }

    @Transactional(readOnly = true)
    public Optional<RefreshToken> validate(String rawToken) {
        if (rawToken == null || rawToken.isBlank()) {
            return Optional.empty();
        }
        String hash = sha256Hex(rawToken);
        return repo.findByTokenHash(hash).flatMap(entity -> {
            if (entity.getRevokedAt() != null) {
                return Optional.empty();
            }
            if (entity.getExpiresAt().isBefore(OffsetDateTime.now())) {
                return Optional.empty();
            }
            return Optional.of(entity);
        });
    }

    /**
     * Rotates a refresh token atomically:
     * <ul>
     *   <li>Unknown hash → empty.</li>
     *   <li>Already-revoked token presented (theft signal) → walk the rotation chain in
     *       both directions, revoke every still-active node, return empty.</li>
     *   <li>Expired token → empty (no chain revocation; the user just needs to log in
     *       again).</li>
     *   <li>Valid token → mint a new one, point the old row at it via {@code replaced_by},
     *       stamp the old row's {@code revoked_at}, return the new token.</li>
     * </ul>
     *
     * <p>A scalar token observation identifies the user without caching token state.
     * Rotation then locks the user row before re-reading the token {@code FOR UPDATE},
     * matching the user → token order used by account deletion and password mutation.
     * The locked token identity and user must still match the observation before a child
     * is minted.
     */
    @Transactional
    public Optional<IssuedRefreshToken> rotate(String rawToken) {
        if (rawToken == null || rawToken.isBlank()) {
            return Optional.empty();
        }
        OffsetDateTime now = OffsetDateTime.now();
        String hash = sha256Hex(rawToken);
        Optional<TokenObservation> maybeObservation = repo.findObservationByTokenHash(hash);
        if (maybeObservation.isEmpty()) {
            return Optional.empty();
        }
        TokenObservation observation = maybeObservation.get();
        if (userRepository.findByIdForUpdate(observation.getUserId()).isEmpty()) {
            return Optional.empty();
        }

        Optional<RefreshToken> maybe = repo.findByTokenHashForUpdate(hash);
        if (maybe.isEmpty()) {
            return Optional.empty();
        }
        RefreshToken existing = maybe.get();
        if (!observation.getId().equals(existing.getId())
            || !observation.getUserId().equals(existing.getUserId())) {
            return Optional.empty();
        }

        if (existing.getRevokedAt() != null) {
            // Reuse-detection: the caller is presenting a token we already retired. Treat
            // every connected node as compromised.
            revokeChain(existing, now);
            return Optional.empty();
        }

        if (existing.getExpiresAt().isBefore(now)) {
            return Optional.empty();
        }

        IssuedRefreshToken next = mint(existing.getUserId(), now);
        existing.setReplacedBy(next.entity().getId());
        existing.revoke(now);
        // The save here is technically redundant inside an open Hibernate session
        // (dirty-checking flushes it), but being explicit guards against lazy-config
        // surprises and helps unit tests that mock the repo.
        repo.save(existing);
        return Optional.of(next);
    }

    @Transactional
    public void revokeAllForUser(Long userId) {
        repo.revokeAllForUser(userId, OffsetDateTime.now());
    }

    /**
     * Revoke a single refresh token identified by its raw value (the cookie payload).
     * Used by {@code POST /api/auth/logout}, which is intentionally a no-op when the
     * cookie is absent, malformed, or already-revoked — the response is the same 204
     * either way to avoid leaking validity status.
     *
     * <p>Hashes the token, looks up the row, and stamps {@code revoked_at} only if the
     * row exists and is not already revoked. Does NOT walk the rotation chain — logout
     * only retires the token the caller possesses, leaving any pre-rotation siblings
     * (already revoked) and post-rotation children (none should exist for a token still
     * in use, but logging out an old one is benign) untouched.
     */
    @Transactional
    public void revokeByRawToken(String rawToken) {
        if (rawToken == null || rawToken.isBlank()) {
            return;
        }
        String hash = sha256Hex(rawToken);
        repo.findByTokenHash(hash).ifPresent(entity -> {
            if (entity.getRevokedAt() == null) {
                entity.revoke(OffsetDateTime.now());
                repo.save(entity);
            }
        });
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private IssuedRefreshToken mint(Long userId, OffsetDateTime now) {
        byte[] raw = new byte[RAW_TOKEN_BYTES];
        random.nextBytes(raw);
        String rawToken = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        String hash = sha256Hex(rawToken);
        RefreshToken entity = new RefreshToken(userId, hash, now.plus(REFRESH_TOKEN_TTL));
        RefreshToken saved = repo.save(entity);
        return new IssuedRefreshToken(rawToken, saved);
    }

    private void revokeChain(RefreshToken seed, OffsetDateTime now) {
        // Forward — follow replaced_by until we either hit a node we've already touched
        // or run out of links. We cap iterations defensively so a corrupted DB cycle can't
        // wedge the request thread.
        final int safetyLimit = 1024;
        RefreshToken cursor = seed;
        int steps = 0;
        while (cursor != null && steps++ < safetyLimit) {
            if (cursor.getRevokedAt() == null) {
                cursor.revoke(now);
                repo.save(cursor);
            }
            Long nextId = cursor.getReplacedBy();
            if (nextId == null) {
                break;
            }
            cursor = repo.findById(nextId).orElse(null);
        }

        // Backward — repeatedly find the node whose replaced_by points at the current id,
        // walking toward the original token in the family.
        cursor = seed;
        steps = 0;
        while (cursor != null && steps++ < safetyLimit) {
            Optional<RefreshToken> previous = repo.findByReplacedBy(cursor.getId());
            if (previous.isEmpty()) {
                break;
            }
            RefreshToken prev = previous.get();
            if (prev.getRevokedAt() == null) {
                prev.revoke(now);
                repo.save(prev);
            }
            cursor = prev;
        }
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandatory in every JDK; this is a JVM bug if it ever throws.
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
