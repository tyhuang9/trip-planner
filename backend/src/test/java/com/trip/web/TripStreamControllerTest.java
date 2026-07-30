package com.trip.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.LocalDate;
import java.util.Optional;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.domain.GuestSession;
import com.trip.domain.ShareLink;
import com.trip.repo.ActivityRepository;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.JwtService;
import com.trip.service.realtime.TripEventBroker;
import com.trip.service.share.ShareTokenService;
import com.trip.service.trip.ReflectionIds;
import com.trip.web.auth.GuestSessionCookie;

import jakarta.servlet.http.Cookie;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class TripStreamControllerTest {

    private static final long ALICE_ID = 100L;
    private static final long TRIP_PK = 42L;
    private static final long SHARE_LINK_ID = 501L;
    private static final long GUEST_ID = 701L;
    private static final String TRIP_PUBLIC_ID = "abc23def45gh";
    private static final String RAW_GUEST_TOKEN = "guestabcdefghijklmnopqrstuvwxyz123456";
    private static final String STREAM_CLIENT_ID = "mobile-client-0001";

    @Autowired
    MockMvc mvc;

    @Autowired
    JwtService realJwtService;

    @Autowired
    ShareTokenService shareTokenService;

    @Autowired
    TripEventBroker tripEventBroker;

    @MockitoBean
    UserRepository userRepository;

    @MockitoBean
    RefreshTokenRepository refreshTokenRepository;

    @MockitoBean
    TripRepository tripRepository;

    @MockitoBean
    TripMemberRepository tripMemberRepository;

    @MockitoBean
    ActivityRepository activityRepository;

    @MockitoBean
    GuestSessionRepository guestSessionRepository;

    @MockitoBean
    PasswordResetTokenRepository passwordResetTokenRepository;

    @MockitoBean
    ShareLinkRepository shareLinkRepository;

    private GuestSession guestSession;

    @BeforeEach
    void wireDefaults() {
        Trip trip = new Trip(
            TRIP_PUBLIC_ID,
            ALICE_ID,
            "Tokyo 2026",
            "Tokyo, Japan",
            LocalDate.of(2026, 5, 1),
            LocalDate.of(2026, 5, 3));
        ReflectionIds.setId(trip, TRIP_PK);
        when(tripRepository.findByPublicId(TRIP_PUBLIC_ID)).thenReturn(Optional.of(trip));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, ALICE_ID))
            .thenReturn(Optional.of(new TripMember(TRIP_PK, ALICE_ID, TripRole.VIEWER)));

        guestSession = new GuestSession(
            SHARE_LINK_ID,
            shareTokenService.sha256Hex(RAW_GUEST_TOKEN),
            "Guest Alice");
        ReflectionIds.setId(guestSession, GUEST_ID);
        ShareLink shareLink = new ShareLink(
            TRIP_PK,
            "share-token-hash",
            TripRole.VIEWER,
            true,
            ALICE_ID,
            null);
        ReflectionIds.setId(shareLink, SHARE_LINK_ID);
        when(guestSessionRepository.findByTokenHash(shareTokenService.sha256Hex(RAW_GUEST_TOKEN)))
            .thenReturn(Optional.of(guestSession));
        when(shareLinkRepository.findById(SHARE_LINK_ID)).thenReturn(Optional.of(shareLink));
    }

    @AfterEach
    void disconnectStreams() {
        tripEventBroker.disconnect(TRIP_PK);
    }

    @Test
    void streamRequiresAuthentication() throws Exception {
        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void streamStartsForTripViewer() throws Exception {
        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .header("Authorization", bearerFor(ALICE_ID))
                .header(TripStreamController.STREAM_CLIENT_HEADER, STREAM_CLIENT_ID))
            .andExpect(status().isOk())
            .andExpect(request().asyncStarted());
    }

    @Test
    void streamStartsForGuestViewer() throws Exception {
        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .cookie(new Cookie(GuestSessionCookie.COOKIE_NAME, RAW_GUEST_TOKEN))
                .header(TripStreamController.STREAM_CLIENT_HEADER, STREAM_CLIENT_ID))
            .andExpect(status().isOk())
            .andExpect(request().asyncStarted());
    }

    @Test
    void streamRejectsClaimedGuestCredential() throws Exception {
        guestSession.invalidateCredential(java.time.OffsetDateTime.now());

        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .cookie(new Cookie(GuestSessionCookie.COOKIE_NAME, RAW_GUEST_TOKEN))
                .header(TripStreamController.STREAM_CLIENT_HEADER, STREAM_CLIENT_ID))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void repeatedSameClientReconnectsReplaceWithoutExhaustingActorLimit() throws Exception {
        for (int index = 0; index < 3; index++) {
            mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                    .header("Authorization", bearerFor(ALICE_ID))
                    .header(TripStreamController.STREAM_CLIENT_HEADER, STREAM_CLIENT_ID))
                .andExpect(status().isOk())
                .andExpect(request().asyncStarted());
        }
    }

    @Test
    void streamRejectsInvalidClientIdentity() throws Exception {
        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .header("Authorization", bearerFor(ALICE_ID))
                .header(TripStreamController.STREAM_CLIENT_HEADER, "short"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("validation_failed"));
    }

    @Test
    void streamRejectsExcessActorSubscriptions() throws Exception {
        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .header("Authorization", bearerFor(ALICE_ID))
                .with(request -> {
                    request.setRemoteAddr("203.0.113.10");
                    return request;
                }))
            .andExpect(status().isOk())
            .andExpect(request().asyncStarted());
        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .header("Authorization", bearerFor(ALICE_ID))
                .with(request -> {
                    request.setRemoteAddr("203.0.113.10");
                    return request;
                }))
            .andExpect(status().isOk())
            .andExpect(request().asyncStarted());

        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .header("Authorization", bearerFor(ALICE_ID))
                .with(request -> {
                    request.setRemoteAddr("203.0.113.10");
                    return request;
                }))
            .andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.error").value("rate_limited"));
    }

    @Test
    void streamReturns404ForInaccessibleTrip() throws Exception {
        when(tripRepository.findByPublicId(TRIP_PUBLIC_ID)).thenReturn(Optional.empty());

        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/stream")
                .header("Authorization", bearerFor(ALICE_ID)))
            .andExpect(status().isNotFound());
    }

    private String bearerFor(long userId) {
        return "Bearer " + realJwtService.issueAccessToken(userId);
    }
}
