package com.trip.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.trip.domain.GuestSession;
import com.trip.domain.ShareLink;
import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.repo.ActivityRepository;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.ShareLinkSummary;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.JwtService;
import com.trip.service.realtime.TripEventPublisher;
import com.trip.service.share.ShareTokenService;
import com.trip.service.trip.ReflectionIds;
import com.trip.web.auth.GuestSessionCookie;
import com.trip.web.dto.share.AcceptGuestShareLinkBodyRequest;
import com.trip.web.dto.share.AcceptShareLinkRequest;

import jakarta.servlet.http.Cookie;

@SpringBootTest(properties = {
    "app.frontend-origin=http://localhost:3000,http://127.0.0.1:3000",
    "app.public-frontend-url=https://app.example.com"
})
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ShareLinkControllerTest {

    private static final long ALICE_ID = 100L;
    private static final long BOB_ID = 200L;
    private static final long TRIP_PK = 42L;
    private static final String TRIP_PUBLIC_ID = "abc23def45gh";
    private static final String RAW_TOKEN = "abcdefghijklmnopqrstuvwxyz1234567890";
    private static final String EXPIRED_TOKEN = "expiredabcdefghijklmnopqrstuvwxyz123456";
    private static final String RATE_LIMIT_TOKEN = "ratelimitabcdefghijklmnopqrstuvwxyz12";
    private static final String RAW_GUEST_TOKEN = "guest-session-token-abcdefghijklmnopqrstuvwxyz";

    @Autowired
    MockMvc mvc;

    @Autowired
    ObjectMapper objectMapper;

    @Autowired
    JwtService realJwtService;

    @Autowired
    ShareTokenService shareTokenService;

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

    @MockitoBean
    TripEventPublisher tripEventPublisher;

    private Trip trip;

    @BeforeEach
    void wireDefaults() {
        trip = new Trip(
            TRIP_PUBLIC_ID,
            ALICE_ID,
            "Tokyo 2026",
            "Tokyo, Japan",
            LocalDate.of(2026, 5, 1),
            LocalDate.of(2026, 5, 3));
        ReflectionIds.setId(trip, TRIP_PK);
        when(tripRepository.findByPublicId(TRIP_PUBLIC_ID)).thenReturn(Optional.of(trip));
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, ALICE_ID))
            .thenReturn(Optional.of(new TripMember(TRIP_PK, ALICE_ID, TripRole.OWNER)));
        when(shareLinkRepository.findByTokenHash(any())).thenReturn(Optional.empty());
        when(guestSessionRepository.findByTokenHash(any())).thenReturn(Optional.empty());
    }

    @Test
    void createReturnsOneTimeShareUrlAndPersistsOnlyTokenHash() throws Exception {
        when(shareLinkRepository.save(any(ShareLink.class))).thenAnswer(invocation -> {
            ShareLink saved = invocation.getArgument(0);
            ReflectionIds.setId(saved, 501L);
            return saved;
        });

        mvc.perform(post("/api/trips/" + TRIP_PUBLIC_ID + "/share-links")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "role", "EDITOR",
                    "name", "  Planning crew\n",
                    "allowAnonymous", false))))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.id").value(501))
            .andExpect(jsonPath("$.role").value("EDITOR"))
            .andExpect(jsonPath("$.name").value("Planning crew"))
            .andExpect(jsonPath("$.allowAnonymous").value(false))
            .andExpect(jsonPath("$.token").doesNotExist())
            .andExpect(jsonPath("$.shareUrl").value(org.hamcrest.Matchers.startsWith(
                "https://app.example.com/share/")));

        ArgumentCaptor<ShareLink> saved = ArgumentCaptor.forClass(ShareLink.class);
        verify(shareLinkRepository).save(saved.capture());
        assertThat(saved.getValue().getTripId()).isEqualTo(TRIP_PK);
        assertThat(saved.getValue().getCreatedBy()).isEqualTo(ALICE_ID);
        assertThat(saved.getValue().getRole()).isEqualTo(TripRole.EDITOR);
        assertThat(saved.getValue().getName()).isEqualTo("Planning crew");
        assertThat(saved.getValue().isAllowAnonymous()).isFalse();
        assertThat(saved.getValue().getTokenHash()).hasSize(64);
        assertThat(saved.getValue().getTokenHash()).doesNotContain("http", "share");
        verify(tripEventPublisher).publishAfterCommit(eq(TRIP_PK), argThat(event ->
            event.type().equals("share-links.changed")
                && event.activityId() == null
                && event.dayDate() == null));
    }

    @Test
    void createRejectsOwnerRole() throws Exception {
        mvc.perform(post("/api/trips/" + TRIP_PUBLIC_ID + "/share-links")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "role", "OWNER",
                    "allowAnonymous", false))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("invalid_share_role"));

        verify(shareLinkRepository, never()).save(any(ShareLink.class));
    }

    @Test
    void createAsViewerReturns404() throws Exception {
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, ALICE_ID))
            .thenReturn(Optional.of(new TripMember(TRIP_PK, ALICE_ID, TripRole.VIEWER)));

        mvc.perform(post("/api/trips/" + TRIP_PUBLIC_ID + "/share-links")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "role", "VIEWER",
                    "allowAnonymous", true))))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        verify(shareLinkRepository, never()).save(any(ShareLink.class));
    }

    @Test
    void listReturnsMetadataOnlyWithoutReusableUrls() throws Exception {
        when(shareLinkRepository.findSummariesByTripId(TRIP_PK)).thenReturn(List.of(
            summary(501L, TripRole.EDITOR, "Editors", false, null),
            summary(502L, TripRole.VIEWER, ShareLink.DEFAULT_NAME, true, null)));

        mvc.perform(get("/api/trips/" + TRIP_PUBLIC_ID + "/share-links")
                .header("Authorization", bearerFor(ALICE_ID)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].id").value(501))
            .andExpect(jsonPath("$[0].role").value("EDITOR"))
            .andExpect(jsonPath("$[0].name").value("Editors"))
            .andExpect(jsonPath("$[0].allowAnonymous").value(false))
            .andExpect(jsonPath("$[0].token").doesNotExist())
            .andExpect(jsonPath("$[0].tokenHash").doesNotExist())
            .andExpect(jsonPath("$[0].shareUrl").doesNotExist())
            .andExpect(jsonPath("$[1].id").value(502))
            .andExpect(jsonPath("$[1].name").value("Shared link"))
            .andExpect(jsonPath("$[1].allowAnonymous").value(true))
            .andExpect(jsonPath("$[1].token").doesNotExist())
            .andExpect(jsonPath("$[1].tokenHash").doesNotExist())
            .andExpect(jsonPath("$[1].shareUrl").doesNotExist());
    }

    @Test
    void renameUpdatesNameAndPublishesShareLinksChanged() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, "hash", TripRole.EDITOR, false, ALICE_ID, null);
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(shareLink));
        when(shareLinkRepository.save(any(ShareLink.class))).thenAnswer(invocation -> invocation.getArgument(0));

        mvc.perform(patch("/api/trips/" + TRIP_PUBLIC_ID + "/share-links/501")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "name", "  Public planning\n"))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(501))
            .andExpect(jsonPath("$.name").value("Public planning"))
            .andExpect(jsonPath("$.role").value("EDITOR"));

        assertThat(shareLink.getName()).isEqualTo("Public planning");
        verify(shareLinkRepository).save(shareLink);
        verify(tripEventPublisher).publishAfterCommit(eq(TRIP_PK), argThat(event ->
            event.type().equals("share-links.changed")
                && event.activityId() == null
                && event.dayDate() == null));
    }

    @Test
    void renameAsViewerReturns404() throws Exception {
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, ALICE_ID))
            .thenReturn(Optional.of(new TripMember(TRIP_PK, ALICE_ID, TripRole.VIEWER)));

        mvc.perform(patch("/api/trips/" + TRIP_PUBLIC_ID + "/share-links/501")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("name", "View only"))))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        verify(shareLinkRepository, never()).findById(501L);
    }

    @Test
    void renameMismatchedTripReturns404() throws Exception {
        ShareLink foreign = link(501L, 99L, "hash", TripRole.EDITOR, false, ALICE_ID, null);
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(foreign));

        mvc.perform(patch("/api/trips/" + TRIP_PUBLIC_ID + "/share-links/501")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("name", "Foreign"))))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        assertThat(foreign.getName()).isEqualTo("Shared link");
        verify(shareLinkRepository, never()).save(foreign);
    }

    @Test
    void revokeDeletesLink() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, "hash", TripRole.EDITOR, false, ALICE_ID, null);
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(shareLink));

        mvc.perform(delete("/api/trips/" + TRIP_PUBLIC_ID + "/share-links/501")
                .header("Authorization", bearerFor(ALICE_ID)))
            .andExpect(status().isNoContent());

        assertThat(shareLink.getRevokedAt()).isNull();
        verify(shareLinkRepository).delete(shareLink);
        verify(shareLinkRepository, never()).save(shareLink);
        verify(tripEventPublisher).publishAndDisconnectAfterCommit(eq(TRIP_PK), argThat(event ->
            event.type().equals("share-links.changed")
                && event.activityId() == null
                && event.dayDate() == null));
    }

    @Test
    void revokeMismatchedTripReturns404() throws Exception {
        ShareLink foreign = link(501L, 99L, "hash", TripRole.EDITOR, false, ALICE_ID, null);
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(foreign));

        mvc.perform(delete("/api/trips/" + TRIP_PUBLIC_ID + "/share-links/501")
                .header("Authorization", bearerFor(ALICE_ID)))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        assertThat(foreign.getRevokedAt()).isNull();
        verify(shareLinkRepository, never()).save(foreign);
        verify(shareLinkRepository, never()).delete(foreign);
    }

    @Test
    void acceptForAuthenticatedUserCreatesMembership() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, shareTokenService.sha256Hex(RAW_TOKEN),
            TripRole.EDITOR, false, ALICE_ID, null);
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, BOB_ID))
            .thenReturn(Optional.empty());

        mvc.perform(post("/api/share/accept")
                .with(remoteAddr("203.0.113.31"))
                .header("Authorization", bearerFor(BOB_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("token", RAW_TOKEN))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.publicId").value(TRIP_PUBLIC_ID))
            .andExpect(jsonPath("$.role").value("EDITOR"));

        ArgumentCaptor<TripMember> member = ArgumentCaptor.forClass(TripMember.class);
        verify(tripMemberRepository).save(member.capture());
        assertThat(member.getValue().getId().getTripId()).isEqualTo(TRIP_PK);
        assertThat(member.getValue().getId().getUserId()).isEqualTo(BOB_ID);
        assertThat(member.getValue().getRole()).isEqualTo(TripRole.EDITOR);
    }

    @Test
    void acceptUpgradesExistingLowerRoleButDoesNotDowngradeOwner() throws Exception {
        ShareLink editorLink = link(501L, TRIP_PK, shareTokenService.sha256Hex(RAW_TOKEN),
            TripRole.EDITOR, false, ALICE_ID, null);
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(editorLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));

        TripMember viewer = new TripMember(TRIP_PK, BOB_ID, TripRole.VIEWER);
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, BOB_ID))
            .thenReturn(Optional.of(viewer));

        mvc.perform(post("/api/share/" + RAW_TOKEN + "/accept")
                .header("Authorization", bearerFor(BOB_ID)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.role").value("EDITOR"));

        assertThat(viewer.getRole()).isEqualTo(TripRole.EDITOR);
        verify(tripMemberRepository).save(viewer);

        TripMember owner = new TripMember(TRIP_PK, ALICE_ID, TripRole.OWNER);
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, ALICE_ID))
            .thenReturn(Optional.of(owner));

        mvc.perform(post("/api/share/" + RAW_TOKEN + "/accept")
                .header("Authorization", bearerFor(ALICE_ID)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.role").value("OWNER"));

        assertThat(owner.getRole()).isEqualTo(TripRole.OWNER);
    }

    @Test
    void acceptRevokedOrExpiredLinkReturns404() throws Exception {
        ShareLink revoked = link(501L, TRIP_PK, shareTokenService.sha256Hex(RAW_TOKEN),
            TripRole.VIEWER, false, ALICE_ID, null);
        revoked.revoke(OffsetDateTime.now());
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(revoked));

        mvc.perform(post("/api/share/" + RAW_TOKEN + "/accept")
                .header("Authorization", bearerFor(BOB_ID)))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        ShareLink expired = link(502L, TRIP_PK, shareTokenService.sha256Hex(EXPIRED_TOKEN),
            TripRole.VIEWER, false, ALICE_ID, OffsetDateTime.now().minusMinutes(1));
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(EXPIRED_TOKEN)))
            .thenReturn(Optional.of(expired));

        mvc.perform(post("/api/share/" + EXPIRED_TOKEN + "/accept")
                .header("Authorization", bearerFor(BOB_ID)))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        verify(tripMemberRepository, never()).save(any(TripMember.class));
    }

    @Test
    void acceptWithoutBearerReturns401() throws Exception {
        mvc.perform(post("/api/share/" + RAW_TOKEN + "/accept")
                .with(remoteAddr("203.0.113.32")))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void bodyAcceptWithoutBearerReturns401EvenWithGuestCookie() throws Exception {
        mvc.perform(post("/api/share/accept")
                .with(remoteAddr("203.0.113.33"))
                .cookie(guestCookie())
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("token", RAW_TOKEN))))
            .andExpect(status().isUnauthorized());

        verify(shareLinkRepository, never()).findByTokenHash(any());
    }

    @Test
    void bodyAcceptRejectsInvalidTokenWithoutReflectingIt() throws Exception {
        String invalidToken = "invalid.token-value-123456789";

        String response = mvc.perform(post("/api/share/accept")
                .with(remoteAddr("203.0.113.34"))
                .header("Authorization", bearerFor(BOB_ID))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("token", invalidToken))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("validation_failed"))
            .andReturn().getResponse().getContentAsString();

        assertThat(response).doesNotContain(invalidToken);
        assertThat(new AcceptShareLinkRequest(invalidToken).toString()).doesNotContain(invalidToken);
        verify(shareLinkRepository, never()).findByTokenHash(any());
    }

    @Test
    void bodyRoutesRejectMissingBlankAndOversizedTokensWithoutReflection() throws Exception {
        String oversizedToken = "a".repeat(201);
        int requestNumber = 40;

        for (String route : List.of("/api/share/accept", "/api/share/guest")) {
            List<Map<String, String>> bodies = route.endsWith("/guest")
                ? List.of(
                    Map.of("displayName", "Guest Alice"),
                    Map.of("token", "   ", "displayName", "Guest Alice"),
                    Map.of("token", oversizedToken, "displayName", "Guest Alice"))
                : List.of(
                    Map.of(),
                    Map.of("token", "   "),
                    Map.of("token", oversizedToken));

            for (Map<String, String> body : bodies) {
                var request = post(route)
                    .with(remoteAddr("203.0.113." + requestNumber++))
                    .contentType("application/json")
                    .content(objectMapper.writeValueAsString(body));
                if (route.endsWith("/accept")) {
                    request.header("Authorization", bearerFor(BOB_ID));
                }

                String response = mvc.perform(request)
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error").value("validation_failed"))
                    .andReturn().getResponse().getContentAsString();
                assertThat(response).doesNotContain(oversizedToken);
            }
        }

        verify(shareLinkRepository, never()).findByTokenHash(any());
        verify(guestSessionRepository, never()).save(any(GuestSession.class));
    }

    @Test
    void acceptForGuestSetsOpaqueCookieAndSanitizesDisplayName() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, shareTokenService.sha256Hex(RAW_TOKEN),
            TripRole.VIEWER, true, ALICE_ID, null);
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));

        mvc.perform(post("/api/share/guest")
                .with(remoteAddr("203.0.113.35"))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "token", RAW_TOKEN,
                    "displayName", "  Guest\u202E\nAlice  "))))
            .andExpect(status().isOk())
            .andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.allOf(
                org.hamcrest.Matchers.containsString("guest_session="),
                org.hamcrest.Matchers.containsString("HttpOnly"),
                org.hamcrest.Matchers.containsString("Path=/api"),
                org.hamcrest.Matchers.containsString("Max-Age=1209600"),
                org.hamcrest.Matchers.containsString("SameSite=Strict"))))
            .andExpect(jsonPath("$.publicId").value(TRIP_PUBLIC_ID))
            .andExpect(jsonPath("$.role").value("VIEWER"))
            .andExpect(jsonPath("$.displayName").value("GuestAlice"));

        ArgumentCaptor<GuestSession> guest = ArgumentCaptor.forClass(GuestSession.class);
        verify(guestSessionRepository).save(guest.capture());
        assertThat(guest.getValue().getShareLinkId()).isEqualTo(501L);
        assertThat(guest.getValue().getDisplayName()).isEqualTo("GuestAlice");
        assertThat(guest.getValue().getTokenHash()).hasSize(64);
    }

    @Test
    void bodyGuestAcceptRejectsInvalidTokenWithoutReflectingIt() throws Exception {
        String invalidToken = "invalid.token-value-123456789";

        String response = mvc.perform(post("/api/share/guest")
                .with(remoteAddr("203.0.113.36"))
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of(
                    "token", invalidToken,
                    "displayName", "Guest Alice"))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("validation_failed"))
            .andReturn().getResponse().getContentAsString();

        assertThat(response).doesNotContain(invalidToken);
        assertThat(new AcceptGuestShareLinkBodyRequest(invalidToken, "Guest Alice").toString())
            .doesNotContain(invalidToken);
        verify(guestSessionRepository, never()).save(any(GuestSession.class));
    }

    @Test
    void acceptForGuestRejectsMemberOnlyLink() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, shareTokenService.sha256Hex(RAW_TOKEN),
            TripRole.VIEWER, false, ALICE_ID, null);
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(shareLink));

        mvc.perform(post("/api/share/" + RAW_TOKEN + "/guest")
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("displayName", "Guest Alice"))))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        verify(guestSessionRepository, never()).save(any(GuestSession.class));
    }

    @Test
    void acceptForGuestRejectsDisplayNameThatSanitizesBlank() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, shareTokenService.sha256Hex(RAW_TOKEN),
            TripRole.VIEWER, true, ALICE_ID, null);
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(RAW_TOKEN)))
            .thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));

        mvc.perform(post("/api/share/" + RAW_TOKEN + "/guest")
                .contentType("application/json")
                .content(objectMapper.writeValueAsString(Map.of("displayName", "\u202E\u2066"))))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("invalid_display_name"));

        verify(guestSessionRepository, never()).save(any(GuestSession.class));
    }

    @Test
    void claimGuestSessionWithoutCookieReturns404() throws Exception {
        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(BOB_ID)))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"))
            .andExpect(header().doesNotExist("Set-Cookie"));

        verify(tripMemberRepository, never()).save(any(TripMember.class));
    }

    @Test
    void claimGuestSessionCreatesMembershipReturnsTripAndClearsCookie() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, "share-hash", TripRole.VIEWER, true, ALICE_ID, null);
        GuestSession guestSession = guestSession(501L, RAW_GUEST_TOKEN);
        when(guestSessionRepository.findByTokenHashForUpdate(shareTokenService.sha256Hex(RAW_GUEST_TOKEN)))
            .thenReturn(Optional.of(guestSession));
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, BOB_ID))
            .thenReturn(Optional.empty());

        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(BOB_ID))
                .cookie(guestCookie()))
            .andExpect(status().isOk())
            .andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.allOf(
                org.hamcrest.Matchers.containsString("guest_session="),
                org.hamcrest.Matchers.containsString("Max-Age=0"),
                org.hamcrest.Matchers.containsString("HttpOnly"),
                org.hamcrest.Matchers.containsString("Path=/api"))))
            .andExpect(jsonPath("$.publicId").value(TRIP_PUBLIC_ID))
            .andExpect(jsonPath("$.name").value("Tokyo 2026"))
            .andExpect(jsonPath("$.role").value("VIEWER"));

        ArgumentCaptor<TripMember> member = ArgumentCaptor.forClass(TripMember.class);
        verify(tripMemberRepository).save(member.capture());
        assertThat(member.getValue().getId().getTripId()).isEqualTo(TRIP_PK);
        assertThat(member.getValue().getId().getUserId()).isEqualTo(BOB_ID);
        assertThat(member.getValue().getRole()).isEqualTo(TripRole.VIEWER);
        assertThat(guestSession.getTokenHash()).isNull();
        assertThat(guestSession.getClaimedAt()).isNotNull();
        verify(guestSessionRepository).save(guestSession);
        verify(guestSessionRepository, never()).delete(any(GuestSession.class));
        verify(tripEventPublisher).publishAndDisconnectAfterCommit(eq(TRIP_PK), argThat(event ->
            event.type().equals("members.changed")
                && event.publicId().equals(TRIP_PUBLIC_ID)));
    }

    @Test
    void claimedGuestCredentialCannotBeReplayed() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, "share-hash", TripRole.VIEWER, true, ALICE_ID, null);
        GuestSession guestSession = guestSession(501L, RAW_GUEST_TOKEN);
        when(guestSessionRepository.findByTokenHashForUpdate(shareTokenService.sha256Hex(RAW_GUEST_TOKEN)))
            .thenReturn(Optional.of(guestSession));
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, BOB_ID))
            .thenReturn(Optional.empty());

        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(BOB_ID))
                .cookie(guestCookie()))
            .andExpect(status().isOk());

        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(BOB_ID))
                .cookie(guestCookie()))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"));

        verify(tripMemberRepository).save(any(TripMember.class));
        verify(guestSessionRepository).save(guestSession);
    }

    @Test
    void claimGuestSessionUpgradesLowerRole() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, "share-hash", TripRole.EDITOR, true, ALICE_ID, null);
        GuestSession guestSession = guestSession(501L, RAW_GUEST_TOKEN);
        when(guestSessionRepository.findByTokenHashForUpdate(shareTokenService.sha256Hex(RAW_GUEST_TOKEN)))
            .thenReturn(Optional.of(guestSession));
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));

        TripMember viewer = new TripMember(TRIP_PK, BOB_ID, TripRole.VIEWER);
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, BOB_ID))
            .thenReturn(Optional.of(viewer));

        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(BOB_ID))
                .cookie(guestCookie()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.role").value("EDITOR"));

        assertThat(viewer.getRole()).isEqualTo(TripRole.EDITOR);
        verify(tripMemberRepository).save(viewer);
    }

    @Test
    void claimGuestSessionDoesNotDowngradeOwner() throws Exception {
        ShareLink shareLink = link(501L, TRIP_PK, "share-hash", TripRole.EDITOR, true, ALICE_ID, null);
        GuestSession guestSession = guestSession(501L, RAW_GUEST_TOKEN);
        when(guestSessionRepository.findByTokenHashForUpdate(shareTokenService.sha256Hex(RAW_GUEST_TOKEN)))
            .thenReturn(Optional.of(guestSession));
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(shareLink));
        when(tripRepository.findById(TRIP_PK)).thenReturn(Optional.of(trip));

        TripMember owner = new TripMember(TRIP_PK, ALICE_ID, TripRole.OWNER);
        when(tripMemberRepository.findByIdTripIdAndIdUserId(TRIP_PK, ALICE_ID))
            .thenReturn(Optional.of(owner));

        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(ALICE_ID))
                .cookie(guestCookie()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.role").value("OWNER"));

        assertThat(owner.getRole()).isEqualTo(TripRole.OWNER);
    }

    @Test
    void claimGuestSessionRejectsRevokedOrExpiredLinkWithoutSavingMembership() throws Exception {
        GuestSession guestSession = guestSession(501L, RAW_GUEST_TOKEN);
        when(guestSessionRepository.findByTokenHashForUpdate(shareTokenService.sha256Hex(RAW_GUEST_TOKEN)))
            .thenReturn(Optional.of(guestSession));

        ShareLink revoked = link(501L, TRIP_PK, "share-hash", TripRole.VIEWER, true, ALICE_ID, null);
        revoked.revoke(OffsetDateTime.now());
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(revoked));

        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(BOB_ID))
                .cookie(guestCookie()))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"))
            .andExpect(header().doesNotExist("Set-Cookie"));

        ShareLink expired = link(501L, TRIP_PK, "share-hash", TripRole.VIEWER,
            true, ALICE_ID, OffsetDateTime.now().minusMinutes(1));
        when(shareLinkRepository.findById(501L)).thenReturn(Optional.of(expired));

        mvc.perform(post("/api/guest-session/claim")
                .header("Authorization", bearerFor(BOB_ID))
                .cookie(guestCookie()))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error").value("not_found"))
            .andExpect(header().doesNotExist("Set-Cookie"));

        verify(tripMemberRepository, never()).save(any(TripMember.class));
    }

    @Test
    void shareAcceptIsRateLimitedPerIp() throws Exception {
        when(shareLinkRepository.findByTokenHash(shareTokenService.sha256Hex(RATE_LIMIT_TOKEN)))
            .thenReturn(Optional.empty());

        for (int i = 0; i < 10; i++) {
            mvc.perform(post("/api/share/" + RATE_LIMIT_TOKEN + "/accept")
                    .with(remoteAddr("203.0.113.60"))
                    .header("Authorization", bearerFor(BOB_ID)))
                .andExpect(status().isNotFound());
        }

        mvc.perform(post("/api/share/" + RATE_LIMIT_TOKEN + "/accept")
                .with(remoteAddr("203.0.113.60"))
                .header("Authorization", bearerFor(BOB_ID)))
            .andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.error").value("rate_limited"));
    }

    private String bearerFor(long userId) {
        return "Bearer " + realJwtService.issueAccessToken(userId);
    }

    private static RequestPostProcessor remoteAddr(String remoteAddr) {
        return request -> {
            request.setRemoteAddr(remoteAddr);
            return request;
        };
    }

    private GuestSession guestSession(long shareLinkId, String rawGuestToken) {
        return new GuestSession(
            shareLinkId,
            shareTokenService.sha256Hex(rawGuestToken),
            "Guest Alice");
    }

    private static Cookie guestCookie() {
        return new Cookie(GuestSessionCookie.COOKIE_NAME, RAW_GUEST_TOKEN);
    }

    private static ShareLink link(long id, long tripId, String tokenHash, TripRole role,
                                  boolean allowAnonymous, long createdBy,
                                  OffsetDateTime expiresAt) {
        ShareLink link = new ShareLink(
            tripId, tokenHash, role, ShareLink.DEFAULT_NAME, allowAnonymous, createdBy, expiresAt);
        ReflectionIds.setId(link, id);
        return link;
    }

    private static ShareLinkSummary summary(long id, TripRole role, String name,
                                            boolean allowAnonymous, OffsetDateTime expiresAt) {
        return new ShareLinkSummary(
            id,
            role,
            name,
            allowAnonymous,
            OffsetDateTime.parse("2026-05-22T16:00:00Z"),
            expiresAt,
            null);
    }
}
