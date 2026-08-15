package com.trip.repo;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.trip.domain.GuestSession;

import jakarta.persistence.LockModeType;

/**
 * Spring Data repository for {@link GuestSession}.
 *
 * <p>Guest sessions are created when an anonymous visitor accepts a share link
 * and provides a display name. Each session is bound to a {@code share_link_id}.
 */
public interface GuestSessionRepository extends JpaRepository<GuestSession, Long> {

    /**
     * Find a guest session by its id.
     */
    Optional<GuestSession> findById(Long id);

    Optional<GuestSession> findByTokenHash(String tokenHash);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT g FROM GuestSession g WHERE g.tokenHash = :tokenHash")
    Optional<GuestSession> findByTokenHashForUpdate(@Param("tokenHash") String tokenHash);

    /**
     * Loads only the public attribution fields needed by an activity list.
     */
    @Query("SELECT new com.trip.repo.IdDisplayName(g.id, g.displayName) FROM GuestSession g WHERE g.id IN :ids")
    List<IdDisplayName> findDisplayNamesByIdIn(@Param("ids") Collection<Long> ids);
}
