package com.trip.web;

import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.trip.domain.TripRole;
import com.trip.repo.ActivityRepository;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.JwtService;
import com.trip.service.share.GuestSessionAccessService;
import com.trip.service.share.GuestSessionAccessService.RestoredGuestSession;
import com.trip.web.auth.GuestSessionCookie;
import com.trip.web.exception.NotFoundException;

import jakarta.servlet.http.Cookie;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class GuestSessionControllerTest {

    private static final String RAW_GUEST_TOKEN =
        "guest-session-token-abcdefghijklmnopqrstuvwxyz";

    @Autowired
    MockMvc mvc;

    @Autowired
    JwtService jwtService;

    @MockitoBean
    GuestSessionAccessService guestSessionAccessService;

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

    @Test
    void bootstrapWithoutGuestCredentialIsPublicAndReturnsNoContent() throws Exception {
        mvc.perform(get("/api/guest-session/bootstrap"))
            .andExpect(status().isNoContent())
            .andExpect(content().string(""))
            .andExpect(header().doesNotExist("Set-Cookie"));

        verify(guestSessionAccessService, never()).restore(org.mockito.ArgumentMatchers.anyString());
    }

    @Test
    void bootstrapReturnsOnlySafeGuestTripProjection() throws Exception {
        when(guestSessionAccessService.restore(RAW_GUEST_TOKEN)).thenReturn(
            new RestoredGuestSession("abc23def45gh", TripRole.VIEWER, "Guest Alice"));

        mvc.perform(get("/api/guest-session/bootstrap").cookie(guestCookie()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.publicId").value("abc23def45gh"))
            .andExpect(jsonPath("$.role").value("VIEWER"))
            .andExpect(jsonPath("$.displayName").value("Guest Alice"))
            .andExpect(jsonPath("$.token").doesNotExist())
            .andExpect(jsonPath("$.tokenHash").doesNotExist());
    }

    @Test
    void bootstrapCollapsesInactiveCredentialAndClearsCurrentTransport() throws Exception {
        when(guestSessionAccessService.restore(RAW_GUEST_TOKEN))
            .thenThrow(new NotFoundException("guest session inactive"));

        mvc.perform(get("/api/guest-session/bootstrap").cookie(guestCookie()))
            .andExpect(status().isNoContent())
            .andExpect(content().string(""))
            .andExpect(header().string("Set-Cookie",
                org.hamcrest.Matchers.allOf(
                    org.hamcrest.Matchers.containsString(GuestSessionCookie.COOKIE_NAME + "="),
                    org.hamcrest.Matchers.containsString("Max-Age=0"),
                    org.hamcrest.Matchers.containsString("Path=/api"),
                    org.hamcrest.Matchers.containsString("HttpOnly"))));
    }

    @Test
    void memberBearerTakesPrecedenceOverAnOldGuestCookie() throws Exception {
        mvc.perform(get("/api/guest-session/bootstrap")
                .header("Authorization", "Bearer " + jwtService.issueAccessToken(100L))
                .cookie(guestCookie()))
            .andExpect(status().isNoContent())
            .andExpect(header().doesNotExist("Set-Cookie"));

        verify(guestSessionAccessService, never()).restore(org.mockito.ArgumentMatchers.anyString());
    }

    private static Cookie guestCookie() {
        return new Cookie(GuestSessionCookie.COOKIE_NAME, RAW_GUEST_TOKEN);
    }
}
