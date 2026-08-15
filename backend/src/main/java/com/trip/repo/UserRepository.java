package com.trip.repo;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.trip.domain.User;

/**
 * Spring Data repository for {@link User}.
 *
 * <p><b>Email normalization contract.</b> All {@code User.email} values stored in the DB
 * are pre-normalized via {@link com.trip.service.auth.EmailNormalizer#normalize(String)}
 * (lowercased + trimmed, {@code Locale.ROOT}). All repository lookups receive
 * pre-normalized email. The functional {@code LOWER(email)} unique index in V1 is
 * defense-in-depth.
 *
 * <p><b>Callers MUST pass {@code EmailNormalizer.normalize(email)} — passing a raw email
 * is a contract violation that may silently fail to match.</b> The methods retain the
 * {@code IgnoreCase} suffix for readability, but the case-insensitivity is now enforced
 * by the contract + functional index, not by JPQL transforms on the parameter.
 *
 * <p>The JPQL applies {@code LOWER} only on the column side so the query plan can hit
 * the functional unique index on {@code LOWER(email)} without an extra transform on the
 * bound parameter.
 */
public interface UserRepository extends JpaRepository<User, Long> {

    @Query("SELECT u.passwordHash FROM User u WHERE u.id = :userId")
    Optional<String> findPasswordHashById(@Param("userId") Long userId);

    /**
     * First pessimistic lock for password mutation and account deletion flows.
     * Keeping the lock order user row → token/session rows avoids inversion with
     * the user's cascading token deletes.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT u FROM User u WHERE u.id = :userId")
    Optional<User> findByIdForUpdate(@Param("userId") Long userId);

    @Query("SELECT u FROM User u WHERE LOWER(u.email) = :email")
    Optional<User> findByEmailIgnoreCase(@Param("email") String email);

    @Query("SELECT (COUNT(u) > 0) FROM User u WHERE LOWER(u.email) = :email")
    boolean existsByEmailIgnoreCase(@Param("email") String email);

    @Query("SELECT u FROM User u WHERE LOWER(u.email) LIKE CONCAT('%', :suffix) ORDER BY u.email")
    List<User> findByEmailEndingWithIgnoreCaseOrderByEmail(@Param("suffix") String suffix);

    /**
     * Loads only the public attribution fields needed by an activity list.
     */
    @Query("SELECT new com.trip.repo.IdDisplayName(u.id, u.displayName) FROM User u WHERE u.id IN :ids")
    List<IdDisplayName> findDisplayNamesByIdIn(@Param("ids") Collection<Long> ids);

    @Modifying
    @Query("DELETE FROM User u WHERE u.emailVerifiedAt IS NULL AND u.createdAt < :before")
    int deleteUnverifiedCreatedBefore(@Param("before") OffsetDateTime before);
}
