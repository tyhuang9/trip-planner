package com.trip.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionOperations;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.trip.repo.ActivityRepository;
import com.trip.repo.EmailVerificationTokenRepository;
import com.trip.repo.GoogleApiCacheRepository;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.PasswordResetTokenRepository;
import com.trip.repo.PlaceDetailsCacheRepository;
import com.trip.repo.RefreshTokenRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.repo.UserRepository;
import com.trip.service.auth.JwtService;
import com.trip.service.google.GoogleMapsClient;
import com.trip.service.google.GoogleMapsService;
import com.trip.service.place.GooglePlaceDetailsClient;

@SpringBootTest(properties = {
    "app.frontend-origin=http://localhost:3000",
    "app.jwt-secret=00000000000000000000000000000000000000000000000000000000000000aa",
    "app.log-email-pepper=000000000000000000000000000000aa",
    "app.signup-enabled=false",
    "management.endpoint.health.validate-group-membership=false"
}, classes = com.trip.Application.class)
@AutoConfigureMockMvc
@ActiveProfiles("google-proxy-test")
@org.springframework.boot.autoconfigure.EnableAutoConfiguration(exclude = {
    DataSourceAutoConfiguration.class,
    HibernateJpaAutoConfiguration.class,
    JpaRepositoriesAutoConfiguration.class,
    FlywayAutoConfiguration.class
})
class GoogleMapsProxyControllerTest {

    private static final long ALICE_ID = 100L;

    @Autowired
    MockMvc mvc;

    @Autowired
    ObjectMapper objectMapper;

    @Autowired
    JwtService realJwtService;

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
    EmailVerificationTokenRepository emailVerificationTokenRepository;

    @MockitoBean
    ShareLinkRepository shareLinkRepository;

    @MockitoBean
    TransactionOperations transactionOperations;

    @MockitoBean
    GoogleApiCacheRepository googleApiCacheRepository;

    @MockitoBean
    PlaceDetailsCacheRepository placeDetailsCacheRepository;

    @MockitoBean
    GoogleMapsClient googleMapsClient;

    @MockitoBean
    GooglePlaceDetailsClient googlePlaceDetailsClient;

    @BeforeEach
    void wireDefaults() {
        when(googleApiCacheRepository.findById(any())).thenReturn(Optional.empty());
        when(placeDetailsCacheRepository.findById(any())).thenReturn(Optional.empty());
    }

    @Test
    void placesProxyRequiresBearer() throws Exception {
        mvc.perform(post("/api/places/autocomplete")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"input\":\"pizza\",\"sessionToken\":\"session-one\"}"))
            .andExpect(status().isUnauthorized());

        verify(googleMapsClient, never()).autocomplete(any(), anyString());
    }

    @Test
    void authenticatedAutocompleteProxiesSanitizedRequest() throws Exception {
        when(googleMapsClient.autocomplete(any(), eq(GoogleMapsService.AUTOCOMPLETE_FIELD_MASK)))
            .thenReturn(json("{\"suggestions\":[]}"));

        mvc.perform(post("/api/places/autocomplete")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {
                      "input": " pizza ",
                      "sessionToken": " session-one ",
                      "origin": { "latitude": 41.0, "longitude": -87.0 }
                    }
                    """))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.suggestions").isArray());

        ArgumentCaptor<JsonNode> googleRequest = ArgumentCaptor.forClass(JsonNode.class);
        verify(googleMapsClient).autocomplete(googleRequest.capture(), eq(GoogleMapsService.AUTOCOMPLETE_FIELD_MASK));
        assertThat(googleRequest.getValue().path("input").asText()).isEqualTo("pizza");
        assertThat(googleRequest.getValue().path("sessionToken").asText()).isEqualTo("session-one");
        assertThat(googleRequest.getValue().path("origin").path("longitude").asDouble()).isEqualTo(-87.0);
    }

    @Test
    void invalidTextSearchRequestIsRejectedBeforeGoogle() throws Exception {
        mvc.perform(post("/api/places/text-search")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"textQuery\":\"pizza\",\"apiKey\":\"client-key\"}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("invalid_google_maps_request"));

        verify(googleMapsClient, never()).textSearch(any(), anyString());
    }

    @Test
    void placeDetailsProxyForwardsAutocompleteSessionTokenOnCacheMiss() throws Exception {
        when(googlePlaceDetailsClient.fetchDetails(eq("place-123"), anyString(), eq("session-one")))
            .thenReturn(json("""
                {
                  "id": "place-123",
                  "displayName": { "text": "Pizzeria" },
                  "formattedAddress": "123 Main St"
                }
                """));

        mvc.perform(get("/api/places/place-123/details")
                .header("Authorization", bearerFor(ALICE_ID))
                .param("fields", "photos")
                .param("sessionToken", "session-one"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.source").value("google"))
            .andExpect(jsonPath("$.details.id").value("place-123"));

        verify(googlePlaceDetailsClient).fetchDetails(eq("place-123"), anyString(), eq("session-one"));
    }

    @Test
    void geocodeProxyNormalizesGoogleResponse() throws Exception {
        when(googleMapsClient.geocode("Tokyo")).thenReturn(json("""
            {
              "status": "OK",
              "results": [
                {
                  "formatted_address": "Tokyo, Japan",
                  "geometry": { "location": { "lat": 35.6812, "lng": 139.7671 } }
                }
              ]
            }
            """));

        mvc.perform(post("/api/maps/geocode")
                .header("Authorization", bearerFor(ALICE_ID))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"address\":\" Tokyo \"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.label").value("Tokyo, Japan"))
            .andExpect(jsonPath("$.lat").value(35.6812))
            .andExpect(jsonPath("$.lng").value(139.7671));

        verify(googleMapsClient).geocode("Tokyo");
    }

    private String bearerFor(long userId) {
        return "Bearer " + realJwtService.issueAccessToken(userId);
    }

    private JsonNode json(String source) {
        try {
            return objectMapper.readTree(source);
        } catch (Exception ex) {
            throw new AssertionError(ex);
        }
    }
}
