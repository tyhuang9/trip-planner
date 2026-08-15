package com.trip.service.auth;

import java.time.OffsetDateTime;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.domain.User;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.web.auth.DisplayNameSanitizer;
import com.trip.web.dto.UserSummary;
import com.trip.web.exception.ValidationException;

@Service
public class AccountService {

    public enum DeleteAccountResult {
        DELETED,
        USER_NOT_FOUND,
        REAUTHENTICATION_FAILED
    }

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final RefreshTokenService refreshTokenService;
    private final TripRepository tripRepository;
    private final TripMemberRepository tripMemberRepository;

    public AccountService(UserRepository userRepository,
                          PasswordEncoder passwordEncoder,
                          RefreshTokenService refreshTokenService,
                          TripRepository tripRepository,
                          TripMemberRepository tripMemberRepository) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.refreshTokenService = refreshTokenService;
        this.tripRepository = tripRepository;
        this.tripMemberRepository = tripMemberRepository;
    }

    @Transactional
    public Optional<UserSummary> updateProfile(Long userId, String displayName) {
        String sanitized = DisplayNameSanitizer.sanitize(displayName);
        if (sanitized == null || sanitized.isBlank()) {
            throw new ValidationException("invalid_display_name", "displayName cannot be blank");
        }
        return userRepository.findById(userId)
            .map(user -> {
                user.setDisplayName(sanitized);
                User saved = userRepository.save(user);
                return summary(saved);
            });
    }

    @Transactional
    public boolean changePassword(Long userId, String currentPassword, String newPassword) {
        Optional<String> maybeAuthenticatedHash = userRepository.findPasswordHashById(userId);
        if (maybeAuthenticatedHash.isEmpty()) {
            return false;
        }
        String authenticatedHash = maybeAuthenticatedHash.get();
        if (!passwordEncoder.matches(currentPassword, authenticatedHash)) {
            throw new ValidationException("invalid_current_password", "currentPassword is incorrect");
        }

        String newPasswordHash = passwordEncoder.encode(newPassword);
        Optional<User> maybeLockedUser = userRepository.findByIdForUpdate(userId);
        if (maybeLockedUser.isEmpty()) {
            return false;
        }
        User user = maybeLockedUser.get();
        if (!authenticatedHash.equals(user.getPasswordHash())
            && !passwordEncoder.matches(currentPassword, user.getPasswordHash())) {
            throw new ValidationException("invalid_current_password", "currentPassword is incorrect");
        }

        user.setPasswordHash(newPasswordHash);
        userRepository.save(user);
        refreshTokenService.revokeAllForUser(user.getId());
        return true;
    }

    @Transactional
    public DeleteAccountResult deleteAccount(Long userId, String currentPassword) {
        Optional<String> maybeAuthenticatedHash = userRepository.findPasswordHashById(userId);
        if (maybeAuthenticatedHash.isEmpty()) {
            return DeleteAccountResult.USER_NOT_FOUND;
        }

        String authenticatedHash = maybeAuthenticatedHash.get();
        if (!passwordEncoder.matches(currentPassword, authenticatedHash)) {
            return DeleteAccountResult.REAUTHENTICATION_FAILED;
        }

        // The scalar read keeps BCrypt outside the lock without caching a stale User.
        // From here onward, every password mutation takes the user lock before child rows.
        Optional<User> maybeLockedUser = userRepository.findByIdForUpdate(userId);
        if (maybeLockedUser.isEmpty()) {
            return DeleteAccountResult.USER_NOT_FOUND;
        }
        User user = maybeLockedUser.get();
        if (!authenticatedHash.equals(user.getPasswordHash())
            && !passwordEncoder.matches(currentPassword, user.getPasswordHash())) {
            return DeleteAccountResult.REAUTHENTICATION_FAILED;
        }

        refreshTokenService.revokeAllForUser(userId);

        for (Trip ownedTrip : tripRepository.findAllByOwnerId(userId)) {
            List<TripMember> remainingMembers = tripMemberRepository
                .findAllByIdTripIdOrderByCreatedAtAsc(ownedTrip.getId())
                .stream()
                .filter(member -> !member.getId().getUserId().equals(userId))
                .toList();

            if (remainingMembers.isEmpty()) {
                tripRepository.delete(ownedTrip);
                continue;
            }

            TripMember nextOwner = chooseTransferOwner(remainingMembers);
            ownedTrip.setOwnerId(nextOwner.getId().getUserId());
            tripRepository.save(ownedTrip);
            if (nextOwner.getRole() != TripRole.OWNER) {
                nextOwner.setRole(TripRole.OWNER);
                tripMemberRepository.save(nextOwner);
            }
        }

        userRepository.delete(user);
        return DeleteAccountResult.DELETED;
    }

    private static UserSummary summary(User user) {
        return UserSummary.from(user);
    }

    private static TripMember chooseTransferOwner(List<TripMember> remainingMembers) {
        return remainingMembers.stream()
            .sorted(Comparator
                .comparingInt((TripMember member) -> member.getRole().rank())
                .reversed()
                .thenComparing(member -> {
                    OffsetDateTime createdAt = member.getCreatedAt();
                    return createdAt == null ? OffsetDateTime.MAX : createdAt;
                }))
            .findFirst()
            .orElseThrow();
    }
}
