package com.trip.service.share;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.trip.config.AppProperties;
import com.trip.domain.GuestSession;
import com.trip.domain.ShareLink;
import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.service.trip.ReflectionIds;
import com.trip.web.exception.NotFoundException;

@ExtendWith(MockitoExtension.class)
class GuestSessionAccessServiceTest {

    private static final String RAW_TOKEN = "raw-guest-token";
    private static final String TOKEN_HASH = "guest-token-hash";
    private static final Long GUEST_ID = 10L;
    private static final Long LINK_ID = 20L;
    private static final Long TRIP_ID = 30L;
    private static final Long USER_ID = 40L;
    private static final String PUBLIC_ID = "abc23def45gh";

    @Mock
    private GuestSessionRepository guestSessionRepository;

    @Mock
    private ShareLinkRepository shareLinkRepository;

    @Mock
    private TripRepository tripRepository;

    @Mock
    private TripMemberRepository tripMemberRepository;

    @Mock
    private ShareTokenService shareTokenService;

    private AppProperties appProperties;
    private GuestSessionAccessService service;
    private GuestSession guestSession;
    private ShareLink shareLink;
    private Trip trip;

    @BeforeEach
    void setUp() {
        appProperties = new AppProperties();
        service = new GuestSessionAccessService(
            guestSessionRepository,
            shareLinkRepository,
            tripRepository,
            tripMemberRepository,
            shareTokenService,
            appProperties);

        guestSession = guestSession(OffsetDateTime.now().plusDays(2));
        shareLink = shareLink(null);
        trip = trip();
    }

    @Test
    void restoreReturnsOnlyPublicFieldsForValidCredential() {
        stubReadResolution(guestSession, shareLink, trip);

        GuestSessionAccessService.RestoredGuestSession restored = service.restore(RAW_TOKEN);

        assertThat(restored.publicId()).isEqualTo(PUBLIC_ID);
        assertThat(restored.role()).isEqualTo(TripRole.EDITOR);
        assertThat(restored.displayName()).isEqualTo("Guest Alex");
        assertThat(Arrays.stream(restored.getClass().getRecordComponents())
            .map(component -> component.getName()))
            .containsExactly("publicId", "role", "displayName");
    }

    @Test
    void restoreRejectsBlankAndUnknownCredentials() {
        assertThatThrownBy(() -> service.restore("  "))
            .isInstanceOf(NotFoundException.class);
        assertThatThrownBy(() -> service.restore(null))
            .isInstanceOf(NotFoundException.class);

        when(shareTokenService.sha256Hex(RAW_TOKEN)).thenReturn(TOKEN_HASH);
        when(guestSessionRepository.findByTokenHash(TOKEN_HASH)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.restore(RAW_TOKEN))
            .isInstanceOf(NotFoundException.class);
    }

    @Test
    void restoreRejectsExpiredOrClaimedGuestCredential() {
        GuestSession expired = guestSession(OffsetDateTime.now().minusSeconds(1));
        stubGuestLookup(expired);

        assertThatThrownBy(() -> service.restore(RAW_TOKEN))
            .isInstanceOf(NotFoundException.class);

        GuestSession claimed = guestSession(OffsetDateTime.now().plusDays(1));
        claimed.invalidateCredential(OffsetDateTime.now());
        when(guestSessionRepository.findByTokenHash(TOKEN_HASH)).thenReturn(Optional.of(claimed));

        assertThatThrownBy(() -> service.restore(RAW_TOKEN))
            .isInstanceOf(NotFoundException.class);
        verify(shareLinkRepository, never()).findById(any());
    }

    @Test
    void restoreRejectsRevokedAndExpiredShareLinks() {
        ShareLink revoked = shareLink(null);
        revoked.revoke(OffsetDateTime.now().minusSeconds(1));
        stubGuestLookup(guestSession);
        when(shareLinkRepository.findById(LINK_ID)).thenReturn(Optional.of(revoked));

        assertThatThrownBy(() -> service.restore(RAW_TOKEN))
            .isInstanceOf(NotFoundException.class);

        ShareLink expired = shareLink(OffsetDateTime.now().minusSeconds(1));
        when(shareLinkRepository.findById(LINK_ID)).thenReturn(Optional.of(expired));

        assertThatThrownBy(() -> service.restore(RAW_TOKEN))
            .isInstanceOf(NotFoundException.class);
        verify(tripRepository, never()).findById(any());
    }

    @Test
    void issueRetriesCollisionsAndUsesConfiguredTtl() {
        appProperties.getGuestSession().setTtl(Duration.ofDays(2));
        when(shareTokenService.generateRawToken()).thenReturn("collision", RAW_TOKEN);
        when(shareTokenService.sha256Hex("collision")).thenReturn("collision-hash");
        when(shareTokenService.sha256Hex(RAW_TOKEN)).thenReturn(TOKEN_HASH);
        when(guestSessionRepository.findByTokenHash("collision-hash"))
            .thenReturn(Optional.of(guestSession));
        when(guestSessionRepository.findByTokenHash(TOKEN_HASH)).thenReturn(Optional.empty());
        OffsetDateTime before = OffsetDateTime.now().plusDays(2).minusSeconds(1);

        GuestSessionAccessService.IssuedGuestSession issued = service.issue(LINK_ID, "Guest Alex");

        OffsetDateTime after = OffsetDateTime.now().plusDays(2).plusSeconds(1);
        assertThat(issued.rawGuestToken()).isEqualTo(RAW_TOKEN);
        ArgumentCaptor<GuestSession> saved = ArgumentCaptor.forClass(GuestSession.class);
        verify(guestSessionRepository).save(saved.capture());
        assertThat(saved.getValue().getShareLinkId()).isEqualTo(LINK_ID);
        assertThat(saved.getValue().getTokenHash()).isEqualTo(TOKEN_HASH);
        assertThat(saved.getValue().getDisplayName()).isEqualTo("Guest Alex");
        assertThat(saved.getValue().getExpiresAt()).isBetween(before, after);
    }

    @Test
    void successfulClaimInvalidatesAndSavesCredentialButPreservesRow() {
        stubClaimResolution(guestSession, shareLink, trip);
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_ID, USER_ID))
            .thenReturn(Optional.empty());

        GuestSessionAccessService.ClaimedGuestSession claimed =
            service.claim(RAW_TOKEN, USER_ID);

        assertThat(claimed.trip()).isSameAs(trip);
        assertThat(claimed.effectiveRole()).isEqualTo(TripRole.EDITOR);
        assertThat(guestSession.getTokenHash()).isNull();
        assertThat(guestSession.getClaimedAt()).isNotNull();
        verify(guestSessionRepository).save(guestSession);
        verify(guestSessionRepository, never()).delete(any(GuestSession.class));
        ArgumentCaptor<TripMember> membership = ArgumentCaptor.forClass(TripMember.class);
        verify(tripMemberRepository).save(membership.capture());
        assertThat(membership.getValue().getId().getTripId()).isEqualTo(TRIP_ID);
        assertThat(membership.getValue().getId().getUserId()).isEqualTo(USER_ID);
    }

    @Test
    void failedClaimValidationDoesNotInvalidateOrSaveCredential() {
        ShareLink revoked = shareLink(null);
        revoked.revoke(OffsetDateTime.now().minusSeconds(1));
        when(shareTokenService.sha256Hex(RAW_TOKEN)).thenReturn(TOKEN_HASH);
        when(guestSessionRepository.findByTokenHashForUpdate(TOKEN_HASH))
            .thenReturn(Optional.of(guestSession));
        when(shareLinkRepository.findById(LINK_ID)).thenReturn(Optional.of(revoked));

        assertThatThrownBy(() -> service.claim(RAW_TOKEN, USER_ID))
            .isInstanceOf(NotFoundException.class);

        assertThat(guestSession.getTokenHash()).isEqualTo(TOKEN_HASH);
        assertThat(guestSession.getClaimedAt()).isNull();
        verify(guestSessionRepository, never()).save(any(GuestSession.class));
        verify(tripMemberRepository, never()).save(any(TripMember.class));
    }

    private void stubReadResolution(GuestSession session, ShareLink link, Trip resolvedTrip) {
        stubGuestLookup(session);
        when(shareLinkRepository.findById(LINK_ID)).thenReturn(Optional.of(link));
        when(tripRepository.findById(TRIP_ID)).thenReturn(Optional.of(resolvedTrip));
    }

    private void stubClaimResolution(GuestSession session, ShareLink link, Trip resolvedTrip) {
        when(shareTokenService.sha256Hex(RAW_TOKEN)).thenReturn(TOKEN_HASH);
        when(guestSessionRepository.findByTokenHashForUpdate(TOKEN_HASH))
            .thenReturn(Optional.of(session));
        when(shareLinkRepository.findById(LINK_ID)).thenReturn(Optional.of(link));
        when(tripRepository.findById(TRIP_ID)).thenReturn(Optional.of(resolvedTrip));
    }

    private void stubGuestLookup(GuestSession session) {
        when(shareTokenService.sha256Hex(RAW_TOKEN)).thenReturn(TOKEN_HASH);
        when(guestSessionRepository.findByTokenHash(TOKEN_HASH)).thenReturn(Optional.of(session));
    }

    private static GuestSession guestSession(OffsetDateTime expiresAt) {
        GuestSession session = new GuestSession(
            LINK_ID, TOKEN_HASH, "Guest Alex", expiresAt);
        ReflectionIds.setId(session, GUEST_ID);
        return session;
    }

    private static ShareLink shareLink(OffsetDateTime expiresAt) {
        ShareLink link = new ShareLink(
            TRIP_ID, "share-hash", TripRole.EDITOR, true, 1L, expiresAt);
        ReflectionIds.setId(link, LINK_ID);
        return link;
    }

    private static Trip trip() {
        Trip value = new Trip(
            PUBLIC_ID,
            1L,
            "Tokyo",
            "Tokyo, JP",
            LocalDate.of(2026, 5, 1),
            LocalDate.of(2026, 5, 5));
        ReflectionIds.setId(value, TRIP_ID);
        return value;
    }
}
