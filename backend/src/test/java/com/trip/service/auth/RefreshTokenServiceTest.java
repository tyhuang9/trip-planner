package com.trip.service.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.lang.reflect.Field;
import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;

import com.trip.domain.RefreshToken;
import com.trip.domain.User;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.RefreshTokenRepository.TokenObservation;
import com.trip.repo.UserRepository;
import com.trip.service.auth.RefreshTokenService.IssuedRefreshToken;

/**
 * Pure unit tests for {@link RefreshTokenService}. The repository is mocked; no Spring
 * context, no DB.
 *
 * <p>Coverage:
 * <ul>
 *   <li>Issue → validate roundtrip works.</li>
 *   <li>Revoked or expired tokens come back empty from {@code validate}.</li>
 *   <li>Rotation produces a different raw token AND different hash, and updates the old
 *       row's {@code replaced_by}.</li>
 *   <li>The OLD token cannot be rotated again — the second attempt returns empty AND
 *       triggers chain revocation.</li>
 *   <li>Reuse of a known-revoked token revokes the entire connected chain in both
 *       directions.</li>
 *   <li>The raw token is never persisted (only the hash).</li>
 * </ul>
 */
class RefreshTokenServiceTest {

    private RefreshTokenRepository repo;
    private UserRepository userRepository;
    private RefreshTokenService service;

    /** Fake DB: maps id -> entity, mimics save assigning ids and find-by-hash/replaced-by. */
    private Map<Long, RefreshToken> store;
    private Map<String, RefreshToken> byHash;
    private AtomicLong idSeq;

    @BeforeEach
    void setUp() {
        repo = org.mockito.Mockito.mock(RefreshTokenRepository.class);
        userRepository = org.mockito.Mockito.mock(UserRepository.class);
        store = new HashMap<>();
        byHash = new HashMap<>();
        idSeq = new AtomicLong(1);

        when(repo.save(any(RefreshToken.class))).thenAnswer(inv -> {
            RefreshToken rt = inv.getArgument(0);
            if (rt.getId() == null) {
                setId(rt, idSeq.getAndIncrement());
            }
            store.put(rt.getId(), rt);
            byHash.put(rt.getTokenHash(), rt);
            return rt;
        });
        when(repo.findByTokenHash(any())).thenAnswer(inv ->
            Optional.ofNullable(byHash.get(inv.<String>getArgument(0))));
        when(repo.findObservationByTokenHash(any())).thenAnswer(inv ->
            Optional.ofNullable(byHash.get(inv.<String>getArgument(0)))
                .map(RefreshTokenServiceTest::observation));
        when(repo.findByTokenHashForUpdate(any())).thenAnswer(inv ->
            Optional.ofNullable(byHash.get(inv.<String>getArgument(0))));
        when(repo.findById(anyLong())).thenAnswer(inv ->
            Optional.ofNullable(store.get(inv.<Long>getArgument(0))));
        when(repo.findByReplacedBy(anyLong())).thenAnswer(inv -> {
            Long target = inv.getArgument(0);
            return store.values().stream()
                .filter(rt -> target.equals(rt.getReplacedBy()))
                .findFirst();
        });
        when(userRepository.findByIdForUpdate(anyLong())).thenAnswer(inv ->
            Optional.of(userWithId(inv.getArgument(0))));

        service = new RefreshTokenService(repo, userRepository, new SecureRandom());
    }

    private static void setId(RefreshToken rt, long id) {
        try {
            Field f = RefreshToken.class.getDeclaredField("id");
            f.setAccessible(true);
            f.set(rt, id);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    private static User userWithId(long id) {
        User u = new User("alice@example.com", "hash", "Alice");
        try {
            Field f = User.class.getDeclaredField("id");
            f.setAccessible(true);
            f.set(u, id);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
        return u;
    }

    private static TokenObservation observation(RefreshToken token) {
        return new TokenObservation() {
            @Override
            public Long getId() {
                return token.getId();
            }

            @Override
            public Long getUserId() {
                return token.getUserId();
            }
        };
    }

    // ------------------------------------------------------------------
    // happy paths
    // ------------------------------------------------------------------

    @Test
    void issueThenValidateRoundtrips() {
        IssuedRefreshToken issued = service.issueFor(userWithId(7L));

        assertThat(issued.rawToken()).isNotBlank();
        assertThat(issued.entity().getUserId()).isEqualTo(7L);
        assertThat(issued.entity().getTokenHash()).isNotEqualTo(issued.rawToken());

        Optional<RefreshToken> found = service.validate(issued.rawToken());
        assertThat(found).isPresent();
        assertThat(found.get().getId()).isEqualTo(issued.entity().getId());
    }

    @Test
    void rawTokenIsNeverPersisted() {
        IssuedRefreshToken issued = service.issueFor(userWithId(1L));

        // Capture every save and confirm the raw token doesn't appear in any persisted field.
        ArgumentCaptor<RefreshToken> cap = ArgumentCaptor.forClass(RefreshToken.class);
        verify(repo, atLeast(1)).save(cap.capture());
        for (RefreshToken saved : cap.getAllValues()) {
            assertThat(saved.getTokenHash()).isNotEqualTo(issued.rawToken());
            assertThat(saved.getTokenHash()).hasSize(64); // SHA-256 hex
            // Hash should be deterministic & match the SHA-256 hex of the raw token.
            String expected = sha256Hex(issued.rawToken());
            assertThat(saved.getTokenHash()).isEqualTo(expected);
        }
    }

    // ------------------------------------------------------------------
    // validate edge cases
    // ------------------------------------------------------------------

    @Test
    void validateReturnsEmptyForUnknownToken() {
        assertThat(service.validate("does-not-exist")).isEmpty();
        assertThat(service.validate(null)).isEmpty();
        assertThat(service.validate("")).isEmpty();
    }

    @Test
    void revokedTokenFailsValidate() {
        IssuedRefreshToken issued = service.issueFor(userWithId(1L));
        issued.entity().revoke(OffsetDateTime.now());

        assertThat(service.validate(issued.rawToken())).isEmpty();
    }

    @Test
    void expiredTokenFailsValidate() {
        IssuedRefreshToken issued = service.issueFor(userWithId(1L));
        // Force expiry into the past via reflection.
        try {
            Field f = RefreshToken.class.getDeclaredField("expiresAt");
            f.setAccessible(true);
            f.set(issued.entity(), OffsetDateTime.now().minusDays(1));
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }

        assertThat(service.validate(issued.rawToken())).isEmpty();
    }

    // ------------------------------------------------------------------
    // rotation
    // ------------------------------------------------------------------

    @Test
    void rotateProducesDifferentRawTokenAndHash() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        Optional<IssuedRefreshToken> rotated = service.rotate(first.rawToken());

        assertThat(rotated).isPresent();
        IssuedRefreshToken second = rotated.get();
        assertThat(second.rawToken()).isNotEqualTo(first.rawToken());
        assertThat(second.entity().getTokenHash()).isNotEqualTo(first.entity().getTokenHash());
        assertThat(second.entity().getUserId()).isEqualTo(1L);
    }

    @Test
    void rotateLinksOldToNewViaReplacedBy() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        IssuedRefreshToken second = service.rotate(first.rawToken()).orElseThrow();

        assertThat(first.entity().getReplacedBy()).isEqualTo(second.entity().getId());
        assertThat(first.entity().getRevokedAt()).isNotNull();
        assertThat(second.entity().getReplacedBy()).isNull();
        assertThat(second.entity().getRevokedAt()).isNull();
    }

    @Test
    void rotateLocksUserBeforeTokenAndMintingSuccessor() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        String originalHash = first.entity().getTokenHash();

        service.rotate(first.rawToken()).orElseThrow();

        verify(repo).findObservationByTokenHash(originalHash);
        verify(repo).findByTokenHashForUpdate(originalHash);
        verify(repo, never()).findByTokenHash(originalHash);
        InOrder lockOrder = inOrder(userRepository, repo);
        lockOrder.verify(userRepository).findByIdForUpdate(1L);
        lockOrder.verify(repo).findByTokenHashForUpdate(originalHash);
    }

    @Test
    void rotateFailsClosedWhenObservedTokenDisappearsBeforeLockedRead() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        String originalHash = first.entity().getTokenHash();
        when(repo.findByTokenHashForUpdate(originalHash)).thenReturn(Optional.empty());
        clearInvocations(repo);

        assertThat(service.rotate(first.rawToken())).isEmpty();

        verify(userRepository).findByIdForUpdate(1L);
        verify(repo).findByTokenHashForUpdate(originalHash);
        verify(repo, never()).save(any(RefreshToken.class));
    }

    @Test
    void rotateFailsClosedWhenLockedTokenDiffersFromObservation() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        String originalHash = first.entity().getTokenHash();
        RefreshToken replacement = new RefreshToken(
            2L, originalHash, OffsetDateTime.now().plusDays(30));
        setId(replacement, 99L);
        when(repo.findByTokenHashForUpdate(originalHash))
            .thenReturn(Optional.of(replacement));
        clearInvocations(repo);

        assertThat(service.rotate(first.rawToken())).isEmpty();

        verify(userRepository).findByIdForUpdate(1L);
        verify(repo).findByTokenHashForUpdate(originalHash);
        verify(repo, never()).save(any(RefreshToken.class));
    }

    @Test
    void rotateOfUnknownTokenReturnsEmpty() {
        assertThat(service.rotate("garbage")).isEmpty();
        assertThat(service.rotate(null)).isEmpty();
        assertThat(service.rotate("")).isEmpty();
    }

    @Test
    void rotateOfExpiredTokenReturnsEmptyAndDoesNotRevokeChain() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        // Expire it.
        try {
            Field f = RefreshToken.class.getDeclaredField("expiresAt");
            f.setAccessible(true);
            f.set(first.entity(), OffsetDateTime.now().minusMinutes(1));
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }

        assertThat(service.rotate(first.rawToken())).isEmpty();
        // No revocation triggered — the user just needs to log in again.
        assertThat(first.entity().getRevokedAt()).isNull();
    }

    @Test
    void doubleRotationOfSameTokenRevokesChain() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        IssuedRefreshToken second = service.rotate(first.rawToken()).orElseThrow();
        IssuedRefreshToken third = service.rotate(second.rawToken()).orElseThrow();

        // Now re-present `first` (the now-revoked head): chunk-2a says this triggers
        // chain revocation in both directions.
        assertThat(service.rotate(first.rawToken())).isEmpty();

        assertThat(first.entity().getRevokedAt()).isNotNull();
        assertThat(second.entity().getRevokedAt()).isNotNull();
        assertThat(third.entity().getRevokedAt()).isNotNull();
    }

    @Test
    void reuseOfMidChainTokenRevokesBothDirections() {
        // Build a chain: t1 -> t2 -> t3 -> t4 (each rotated from the previous).
        IssuedRefreshToken t1 = service.issueFor(userWithId(1L));
        IssuedRefreshToken t2 = service.rotate(t1.rawToken()).orElseThrow();
        IssuedRefreshToken t3 = service.rotate(t2.rawToken()).orElseThrow();
        IssuedRefreshToken t4 = service.rotate(t3.rawToken()).orElseThrow();

        // Sanity: only t4 is currently active (the rotation revoked t1..t3).
        assertThat(t1.entity().getRevokedAt()).isNotNull();
        assertThat(t2.entity().getRevokedAt()).isNotNull();
        assertThat(t3.entity().getRevokedAt()).isNotNull();
        assertThat(t4.entity().getRevokedAt()).isNull();

        // Manually un-revoke a node so we can prove the chain-walk re-revokes everything
        // (otherwise the test would just verify "already-revoked nodes stay revoked").
        clearRevokedAt(t4.entity());
        // Also clear t2 to test backward walk re-revocation.
        clearRevokedAt(t2.entity());

        // Re-present a mid-chain revoked token (t1 happens to also be the head).
        // Use t3 (mid-chain) for a clearer bidirectional test: we expect the walker to
        // revoke t4 (forward) AND t2/t1 (backward).
        // First we have to actually make t3 the input — which is currently revoked.
        assertThat(service.rotate(t3.rawToken())).isEmpty();

        assertThat(t1.entity().getRevokedAt()).isNotNull();
        assertThat(t2.entity().getRevokedAt()).isNotNull(); // backward walk
        assertThat(t3.entity().getRevokedAt()).isNotNull();
        assertThat(t4.entity().getRevokedAt()).isNotNull(); // forward walk
    }

    // ------------------------------------------------------------------
    // bulk revoke
    // ------------------------------------------------------------------

    @Test
    void revokeAllForUserDelegatesToRepo() {
        service.revokeAllForUser(42L);
        verify(repo).revokeAllForUser(eq(42L), any(OffsetDateTime.class));
    }

    @Test
    void issueDoesNotConsultBackwardChain() {
        service.issueFor(userWithId(1L));
        // findByReplacedBy should only fire from chain-walks, never from issuance.
        verify(repo, never()).findByReplacedBy(anyLong());
    }

    @Test
    void rotateInvokesSaveExactlyTwice() {
        IssuedRefreshToken first = service.issueFor(userWithId(1L));
        clearInvocations(repo);
        service.rotate(first.rawToken());
        // One save for the new minted token, one for the old retired token.
        verify(repo, times(2)).save(any(RefreshToken.class));
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static void clearRevokedAt(RefreshToken rt) {
        try {
            Field f = RefreshToken.class.getDeclaredField("revokedAt");
            f.setAccessible(true);
            f.set(rt, null);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    private static String sha256Hex(String input) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }
}
