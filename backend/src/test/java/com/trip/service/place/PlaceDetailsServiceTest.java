package com.trip.service.place;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Optional;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.trip.config.AppProperties;
import com.trip.domain.PlaceDetailsCache;
import com.trip.domain.PlaceDetailsCacheId;
import com.trip.repo.PlaceDetailsCacheRepository;

class PlaceDetailsServiceTest {
    private static final String DEFAULT_MASK =
        "id,displayName,formattedAddress,googleMapsUri,location,rating,userRatingCount,types,websiteUri,nationalPhoneNumber";

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Clock clock = Clock.fixed(Instant.parse("2026-06-30T12:00:00Z"), ZoneOffset.UTC);
    private final AppProperties appProperties = new AppProperties();

    @Mock
    private PlaceDetailsCacheRepository cacheRepository;

    @Mock
    private GooglePlaceDetailsClient googleClient;

    private AutoCloseable mocks;
    private PlaceDetailsService service;

    @BeforeEach
    void setUp() {
        mocks = MockitoAnnotations.openMocks(this);
        service = new PlaceDetailsService(cacheRepository, googleClient, appProperties, clock);
    }

    @AfterEach
    void tearDown() throws Exception {
        mocks.close();
    }

    @Test
    void freshCacheHitDoesNotCallGoogle() {
        JsonNode cachedDetails = json("{\"id\":\"place-1\",\"displayName\":{\"text\":\"Cached\"}}");
        when(cacheRepository.findById(new PlaceDetailsCacheId("place-1", DEFAULT_MASK)))
            .thenReturn(Optional.of(cacheRow("place-1", DEFAULT_MASK, cachedDetails, 1)));

        PlaceDetailsResponse response = service.details("place-1", null);

        assertThat(response.source()).isEqualTo("cache");
        assertThat(response.stale()).isFalse();
        assertThat(response.details()).isEqualTo(cachedDetails);
        verify(googleClient, never()).fetchDetails(any(), any(), any());
    }

    @Test
    void missingCacheCallsGoogleAndSavesResult() {
        JsonNode freshDetails = json("{\"id\":\"place-1\",\"displayName\":{\"text\":\"Fresh\"}}");
        when(cacheRepository.findById(new PlaceDetailsCacheId("place-1", DEFAULT_MASK)))
            .thenReturn(Optional.empty());
        when(googleClient.fetchDetails("place-1", DEFAULT_MASK, null)).thenReturn(freshDetails);

        PlaceDetailsResponse response = service.details("place-1", null);

        assertThat(response.source()).isEqualTo("google");
        assertThat(response.details()).isEqualTo(freshDetails);
        ArgumentCaptor<PlaceDetailsCache> saved = ArgumentCaptor.forClass(PlaceDetailsCache.class);
        verify(cacheRepository).save(saved.capture());
        assertThat(saved.getValue().getId()).isEqualTo(new PlaceDetailsCacheId("place-1", DEFAULT_MASK));
        assertThat(saved.getValue().getExpiresAt()).isEqualTo(OffsetDateTime.parse("2026-07-07T12:00:00Z"));
    }

    @Test
    void expiredCacheCallsGoogleAndUpdatesResult() {
        JsonNode staleDetails = json("{\"id\":\"place-1\",\"displayName\":{\"text\":\"Stale\"}}");
        JsonNode freshDetails = json("{\"id\":\"place-1\",\"displayName\":{\"text\":\"Fresh\"}}");
        PlaceDetailsCache staleRow = cacheRow("place-1", DEFAULT_MASK, staleDetails, -1);
        when(cacheRepository.findById(new PlaceDetailsCacheId("place-1", DEFAULT_MASK)))
            .thenReturn(Optional.of(staleRow));
        when(googleClient.fetchDetails("place-1", DEFAULT_MASK, null)).thenReturn(freshDetails);

        PlaceDetailsResponse response = service.details("place-1", null);

        assertThat(response.source()).isEqualTo("google");
        assertThat(staleRow.getDetailsJson()).isEqualTo(freshDetails);
        verify(cacheRepository).save(staleRow);
    }

    @Test
    void googleFailureWithStaleCacheReturnsStaleCache() {
        JsonNode staleDetails = json("{\"id\":\"place-1\",\"displayName\":{\"text\":\"Stale\"}}");
        when(cacheRepository.findById(new PlaceDetailsCacheId("place-1", DEFAULT_MASK)))
            .thenReturn(Optional.of(cacheRow("place-1", DEFAULT_MASK, staleDetails, -1)));
        when(googleClient.fetchDetails("place-1", DEFAULT_MASK, null))
            .thenThrow(PlaceDetailsException.unavailable("boom"));

        PlaceDetailsResponse response = service.details("place-1", null);

        assertThat(response.source()).isEqualTo("stale_cache");
        assertThat(response.stale()).isTrue();
        assertThat(response.details()).isEqualTo(staleDetails);
    }

    @Test
    void googleFailureWithoutCacheThrows() {
        when(cacheRepository.findById(new PlaceDetailsCacheId("place-1", DEFAULT_MASK)))
            .thenReturn(Optional.empty());
        when(googleClient.fetchDetails("place-1", DEFAULT_MASK, null))
            .thenThrow(PlaceDetailsException.rateLimited("quota"));

        assertThatThrownBy(() -> service.details("place-1", null))
            .isInstanceOf(PlaceDetailsException.class)
            .hasMessageContaining("quota");
    }

    @Test
    void differentFieldMasksDoNotReuseIncompleteCache() {
        String expandedMask = DEFAULT_MASK + ",photos,reviews";
        when(cacheRepository.findById(new PlaceDetailsCacheId("place-1", expandedMask)))
            .thenReturn(Optional.empty());
        JsonNode freshDetails = json("{\"id\":\"place-1\",\"photos\":[],\"reviews\":[]}");
        when(googleClient.fetchDetails("place-1", expandedMask, null)).thenReturn(freshDetails);

        PlaceDetailsResponse response = service.details("place-1", "reviews,photos");

        assertThat(response.fieldMask()).isEqualTo(expandedMask);
        verify(cacheRepository).findById(new PlaceDetailsCacheId("place-1", expandedMask));
        verify(cacheRepository, never()).findById(new PlaceDetailsCacheId("place-1", DEFAULT_MASK));
    }

    @Test
    void unsupportedFieldsAreRejected() {
        assertThatThrownBy(() -> service.details("place-1", "editorialSummary"))
            .isInstanceOf(PlaceDetailsException.class);
    }

    @Test
    void cacheMissForwardsAutocompleteSessionTokenToGoogleOnly() {
        JsonNode freshDetails = json("{\"id\":\"place-1\",\"displayName\":{\"text\":\"Fresh\"}}");
        when(cacheRepository.findById(new PlaceDetailsCacheId("place-1", DEFAULT_MASK)))
            .thenReturn(Optional.empty());
        when(googleClient.fetchDetails("place-1", DEFAULT_MASK, "session-123")).thenReturn(freshDetails);

        PlaceDetailsResponse response = service.details("place-1", null, " session-123 ");

        assertThat(response.source()).isEqualTo("google");
        verify(googleClient).fetchDetails("place-1", DEFAULT_MASK, "session-123");
        ArgumentCaptor<PlaceDetailsCache> saved = ArgumentCaptor.forClass(PlaceDetailsCache.class);
        verify(cacheRepository).save(saved.capture());
        assertThat(saved.getValue().getId()).isEqualTo(new PlaceDetailsCacheId("place-1", DEFAULT_MASK));
    }

    private PlaceDetailsCache cacheRow(String placeId, String fieldMask, JsonNode details, long expiresInDays) {
        OffsetDateTime now = OffsetDateTime.now(clock);
        return new PlaceDetailsCache(placeId, fieldMask, details, now.minusDays(1), now.plusDays(expiresInDays));
    }

    private JsonNode json(String source) {
        try {
            return objectMapper.readTree(source);
        } catch (Exception ex) {
            throw new AssertionError(ex);
        }
    }
}
