package com.trip.service.share;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.LocalDate;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.ArgumentCaptor;
import org.mockito.junit.jupiter.MockitoExtension;

import com.trip.config.AppProperties;
import com.trip.domain.ShareLink;
import com.trip.domain.Trip;
import com.trip.domain.TripRole;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.service.realtime.TripEventPublisher;
import com.trip.service.realtime.TripEvent;
import com.trip.service.trip.ReflectionIds;
import com.trip.service.trip.TripAccessGuard;

@ExtendWith(MockitoExtension.class)
class ShareLinkServiceGuestLifecycleTest {

    private static final String RAW_SHARE_TOKEN = "raw-share-token";
    private static final String SHARE_HASH = "share-hash";
    private static final String RAW_GUEST_TOKEN = "raw-guest-token";
    private static final Long LINK_ID = 20L;
    private static final Long TRIP_ID = 30L;
    private static final Long USER_ID = 40L;
    private static final String PUBLIC_ID = "abc23def45gh";

    @Mock
    private ShareLinkRepository shareLinkRepository;

    @Mock
    private TripRepository tripRepository;

    @Mock
    private TripMemberRepository tripMemberRepository;

    @Mock
    private TripAccessGuard tripAccessGuard;

    @Mock
    private ShareTokenService shareTokenService;

    @Mock
    private TripEventPublisher tripEventPublisher;

    @Mock
    private GuestSessionAccessService guestSessionAccessService;

    private ShareLinkService service;
    private ShareLink shareLink;
    private Trip trip;

    @BeforeEach
    void setUp() {
        service = new ShareLinkService(
            shareLinkRepository,
            tripRepository,
            tripMemberRepository,
            tripAccessGuard,
            shareTokenService,
            tripEventPublisher,
            guestSessionAccessService,
            new AppProperties());
        shareLink = new ShareLink(
            TRIP_ID, SHARE_HASH, TripRole.VIEWER, true, 1L, null);
        ReflectionIds.setId(shareLink, LINK_ID);
        trip = new Trip(
            PUBLIC_ID,
            1L,
            "Tokyo",
            "Tokyo, JP",
            LocalDate.of(2026, 5, 1),
            LocalDate.of(2026, 5, 5));
        ReflectionIds.setId(trip, TRIP_ID);
    }

    @Test
    void guestAcceptanceDelegatesCredentialIssuance() {
        when(shareTokenService.sha256Hex(RAW_SHARE_TOKEN)).thenReturn(SHARE_HASH);
        when(shareLinkRepository.findByTokenHash(SHARE_HASH)).thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_ID)).thenReturn(Optional.of(trip));
        when(guestSessionAccessService.issue(LINK_ID, "Guest Alex"))
            .thenReturn(new GuestSessionAccessService.IssuedGuestSession(RAW_GUEST_TOKEN));

        ShareLinkService.AcceptedGuestSession accepted =
            service.acceptForGuest(RAW_SHARE_TOKEN, "Guest Alex");

        assertThat(accepted.rawGuestToken()).isEqualTo(RAW_GUEST_TOKEN);
        assertThat(accepted.response().publicId()).isEqualTo(PUBLIC_ID);
        assertThat(accepted.response().role()).isEqualTo(TripRole.VIEWER);
        assertThat(accepted.response().displayName()).isEqualTo("Guest Alex");
        verify(guestSessionAccessService).issue(LINK_ID, "Guest Alex");
    }

    @Test
    void claimDelegatesAtomicLifecycleAndMapsTripResponse() {
        when(guestSessionAccessService.claim(RAW_GUEST_TOKEN, USER_ID))
            .thenReturn(new GuestSessionAccessService.ClaimedGuestSession(trip, TripRole.EDITOR));

        var response = service.claimGuestSession(RAW_GUEST_TOKEN, USER_ID);

        assertThat(response.publicId()).isEqualTo(PUBLIC_ID);
        assertThat(response.role()).isEqualTo(TripRole.EDITOR);
        verify(guestSessionAccessService).claim(RAW_GUEST_TOKEN, USER_ID);
        ArgumentCaptor<TripEvent> event = ArgumentCaptor.forClass(TripEvent.class);
        verify(tripEventPublisher).publishAndDisconnectAfterCommit(eq(TRIP_ID), event.capture());
        assertThat(event.getValue().type()).isEqualTo("members.changed");
        assertThat(event.getValue().publicId()).isEqualTo(PUBLIC_ID);
    }
}
