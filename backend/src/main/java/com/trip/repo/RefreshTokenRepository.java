package com.trip.repo;

import java.time.OffsetDateTime;
import java.util.Optional;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.trip.domain.RefreshToken;

/**
 * Spring Data repository for {@link RefreshToken}.
 *
 * <p>The V1 schema models the rotation chain as a self-referencing FK:
 * {@code refresh_tokens.replaced_by REFERENCES refresh_tokens(id)}. The entity exposes
 * this as a raw {@code Long} (not a JPA relationship), so the backward-walk query uses
 * the field name {@code replacedBy} directly.
 */
public interface RefreshTokenRepository extends JpaRepository<RefreshToken, Long> {

    interface TokenObservation {
        Long getId();

        Long getUserId();
    }

    Optional<RefreshToken> findByTokenHash(String tokenHash);

    @Query("SELECT rt.id AS id, rt.userId AS userId FROM RefreshToken rt "
        + "WHERE rt.tokenHash = :tokenHash")
    Optional<TokenObservation> findObservationByTokenHash(@Param("tokenHash") String tokenHash);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT rt FROM RefreshToken rt WHERE rt.tokenHash = :tokenHash")
    Optional<RefreshToken> findByTokenHashForUpdate(@Param("tokenHash") String tokenHash);

    Optional<RefreshToken> findByReplacedBy(Long replacedById);

    /**
     * Bulk-revoke every still-active refresh token for a user. Used by "logout everywhere"
     * and account deletion.
     */
    @Modifying
    @Query("UPDATE RefreshToken rt SET rt.revokedAt = :now "
        + "WHERE rt.userId = :userId AND rt.revokedAt IS NULL")
    int revokeAllForUser(@Param("userId") Long userId, @Param("now") OffsetDateTime now);

    @Modifying
    @Query("""
        DELETE FROM RefreshToken rt
        WHERE rt.expiresAt < :cutoff
           OR rt.revokedAt < :cutoff
        """)
    int deleteInactiveBefore(@Param("cutoff") OffsetDateTime cutoff);
}
