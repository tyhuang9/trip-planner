package com.trip.service.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.InOrder;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.crypto.password.PasswordEncoder;

import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.domain.User;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.service.trip.ReflectionIds;

@ExtendWith(MockitoExtension.class)
class AccountServiceTest {

    @Mock
    UserRepository userRepository;

    @Mock
    PasswordEncoder passwordEncoder;

    @Mock
    RefreshTokenService refreshTokenService;

    @Mock
    TripRepository tripRepository;

    @Mock
    TripMemberRepository tripMemberRepository;

    AccountService service;

    @BeforeEach
    void setUp() {
        service = new AccountService(
            userRepository,
            passwordEncoder,
            refreshTokenService,
            tripRepository,
            tripMemberRepository);
    }

    @Test
    void changePasswordLocksUserBeforeRevokingRefreshTokens() {
        User user = userWith(1L);
        when(userRepository.findPasswordHashById(1L)).thenReturn(Optional.of("hash"));
        when(passwordEncoder.matches("current-secret", "hash")).thenReturn(true);
        when(passwordEncoder.encode("new-secret")).thenReturn("new-hash");
        when(userRepository.findByIdForUpdate(1L)).thenReturn(Optional.of(user));

        assertThat(service.changePassword(1L, "current-secret", "new-secret")).isTrue();

        assertThat(user.getPasswordHash()).isEqualTo("new-hash");
        InOrder lockOrder = inOrder(userRepository, refreshTokenService);
        lockOrder.verify(userRepository).findByIdForUpdate(1L);
        lockOrder.verify(userRepository).save(user);
        lockOrder.verify(refreshTokenService).revokeAllForUser(1L);
    }

    @Test
    void deleteAccountWithSameLockedHashDeletesOwnedTripWithNoRemainingMembers() {
        User user = userWith(1L);
        Trip privateTrip = tripWith(10L, 1L);
        TripMember owner = new TripMember(10L, 1L, TripRole.OWNER);
        when(userRepository.findPasswordHashById(1L)).thenReturn(Optional.of("hash"));
        when(userRepository.findByIdForUpdate(1L)).thenReturn(Optional.of(user));
        when(passwordEncoder.matches("current-secret", "hash")).thenReturn(true);
        when(tripRepository.findAllByOwnerId(1L)).thenReturn(List.of(privateTrip));
        when(tripMemberRepository.findAllByIdTripIdOrderByCreatedAtAsc(10L))
            .thenReturn(List.of(owner));

        assertThat(service.deleteAccount(1L, "current-secret"))
            .isEqualTo(AccountService.DeleteAccountResult.DELETED);

        verify(refreshTokenService).revokeAllForUser(1L);
        verify(tripRepository).delete(privateTrip);
        verify(tripRepository, never()).save(privateTrip);
        verify(userRepository).delete(user);
        InOrder destructiveOrder = inOrder(passwordEncoder, refreshTokenService, tripRepository, userRepository);
        destructiveOrder.verify(passwordEncoder).matches("current-secret", "hash");
        destructiveOrder.verify(userRepository).findByIdForUpdate(1L);
        destructiveOrder.verify(refreshTokenService).revokeAllForUser(1L);
        destructiveOrder.verify(tripRepository).delete(privateTrip);
        destructiveOrder.verify(userRepository).delete(user);
        verify(passwordEncoder, times(1)).matches("current-secret", "hash");
    }

    @Test
    void deleteAccountTransfersSharedOwnedTripToBestRemainingMember() {
        User user = userWith(1L);
        Trip sharedTrip = tripWith(10L, 1L);
        TripMember owner = new TripMember(10L, 1L, TripRole.OWNER);
        TripMember viewer = new TripMember(10L, 2L, TripRole.VIEWER);
        TripMember editor = new TripMember(10L, 3L, TripRole.EDITOR);
        when(userRepository.findPasswordHashById(1L)).thenReturn(Optional.of("hash"));
        when(userRepository.findByIdForUpdate(1L)).thenReturn(Optional.of(user));
        when(passwordEncoder.matches("current-secret", "hash")).thenReturn(true);
        when(tripRepository.findAllByOwnerId(1L)).thenReturn(List.of(sharedTrip));
        when(tripMemberRepository.findAllByIdTripIdOrderByCreatedAtAsc(10L))
            .thenReturn(List.of(owner, viewer, editor));

        assertThat(service.deleteAccount(1L, "current-secret"))
            .isEqualTo(AccountService.DeleteAccountResult.DELETED);

        assertThat(sharedTrip.getOwnerId()).isEqualTo(3L);
        assertThat(editor.getRole()).isEqualTo(TripRole.OWNER);
        assertThat(viewer.getRole()).isEqualTo(TripRole.VIEWER);
        verify(tripRepository).save(sharedTrip);
        verify(tripRepository, never()).delete(sharedTrip);
        verify(tripMemberRepository).save(editor);
        verify(userRepository).delete(user);
    }

    @Test
    void deleteAccountForMissingUserReturnsWithoutSideEffects() {
        when(userRepository.findPasswordHashById(1L)).thenReturn(Optional.empty());

        assertThat(service.deleteAccount(1L, "current-secret"))
            .isEqualTo(AccountService.DeleteAccountResult.USER_NOT_FOUND);

        verifyNoInteractions(passwordEncoder, refreshTokenService, tripRepository, tripMemberRepository);
        verify(userRepository, never()).delete(org.mockito.ArgumentMatchers.any(User.class));
    }

    @Test
    void deleteAccountForWrongPasswordReturnsWithoutSideEffects() {
        when(userRepository.findPasswordHashById(1L)).thenReturn(Optional.of("hash"));
        when(passwordEncoder.matches("incorrect-secret", "hash")).thenReturn(false);

        assertThat(service.deleteAccount(1L, "incorrect-secret"))
            .isEqualTo(AccountService.DeleteAccountResult.REAUTHENTICATION_FAILED);

        verify(passwordEncoder).matches("incorrect-secret", "hash");
        verify(userRepository, never()).findByIdForUpdate(any());
        verifyNoInteractions(refreshTokenService, tripRepository, tripMemberRepository);
        verify(userRepository, never()).delete(org.mockito.ArgumentMatchers.any(User.class));
    }

    @Test
    void deleteAccountRejectsPasswordChangedBeforeUserLockWithoutSideEffects() {
        User lockedUser = userWith(1L);
        lockedUser.setPasswordHash("changed-hash");
        when(userRepository.findPasswordHashById(1L)).thenReturn(Optional.of("hash"));
        when(userRepository.findByIdForUpdate(1L)).thenReturn(Optional.of(lockedUser));
        when(passwordEncoder.matches("current-secret", "hash")).thenReturn(true);
        when(passwordEncoder.matches("current-secret", "changed-hash")).thenReturn(false);

        assertThat(service.deleteAccount(1L, "current-secret"))
            .isEqualTo(AccountService.DeleteAccountResult.REAUTHENTICATION_FAILED);

        verify(passwordEncoder).matches("current-secret", "hash");
        verify(passwordEncoder).matches("current-secret", "changed-hash");
        verifyNoInteractions(refreshTokenService, tripRepository, tripMemberRepository);
        verify(userRepository, never()).delete(any(User.class));
    }

    private static User userWith(long id) {
        User user = new User("alice@example.com", "hash", "Alice");
        ReflectionIds.setId(user, id);
        return user;
    }

    private static Trip tripWith(long id, long ownerId) {
        Trip trip = new Trip(
            "abc23def45gh",
            ownerId,
            "Tokyo 2026",
            "Tokyo, Japan",
            LocalDate.of(2026, 5, 1),
            LocalDate.of(2026, 5, 3));
        ReflectionIds.setId(trip, id);
        return trip;
    }
}
