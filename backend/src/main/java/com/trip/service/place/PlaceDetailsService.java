package com.trip.service.place;

import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Executor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.trip.config.AppProperties;
import com.trip.domain.PlaceDetailsCache;
import com.trip.domain.PlaceDetailsCacheId;
import com.trip.repo.PlaceDetailsCacheRepository;

@Service
@Profile("!test")
public class PlaceDetailsService {
    private static final Logger log = LoggerFactory.getLogger(PlaceDetailsService.class);

    private static final List<String> DEFAULT_FIELDS = List.of(
        "id",
        "displayName",
        "formattedAddress",
        "googleMapsUri",
        "location",
        "rating",
        "userRatingCount",
        "types",
        "websiteUri",
        "nationalPhoneNumber"
    );
    private static final List<String> EXPANDED_FIELDS = List.of(
        "regularOpeningHours",
        "currentOpeningHours",
        "photos",
        "reviews"
    );
    private static final Set<String> ALLOWED_FIELDS = buildAllowedFields();

    private final PlaceDetailsCacheRepository cacheRepository;
    private final GooglePlaceDetailsClient googleClient;
    private final AppProperties appProperties;
    private final Clock clock;
    private final Executor cacheSaveExecutor;

    @Autowired
    public PlaceDetailsService(PlaceDetailsCacheRepository cacheRepository,
                               GooglePlaceDetailsClient googleClient,
                               AppProperties appProperties,
                               @Qualifier("placeDetailsCacheSaveExecutor") Executor cacheSaveExecutor) {
        this(cacheRepository, googleClient, appProperties, Clock.systemUTC(), cacheSaveExecutor);
    }

    PlaceDetailsService(PlaceDetailsCacheRepository cacheRepository,
                        GooglePlaceDetailsClient googleClient,
                        AppProperties appProperties,
                        Clock clock) {
        this(cacheRepository, googleClient, appProperties, clock, Runnable::run);
    }

    PlaceDetailsService(PlaceDetailsCacheRepository cacheRepository,
                        GooglePlaceDetailsClient googleClient,
                        AppProperties appProperties,
                        Clock clock,
                        Executor cacheSaveExecutor) {
        this.cacheRepository = cacheRepository;
        this.googleClient = googleClient;
        this.appProperties = appProperties;
        this.clock = clock;
        this.cacheSaveExecutor = cacheSaveExecutor;
    }

    public PlaceDetailsResponse details(String placeId, String fields) {
        return details(placeId, fields, null);
    }

    public PlaceDetailsResponse details(String placeId, String fields, String sessionToken) {
        return details(placeId, fields, sessionToken, null);
    }

    public PlaceDetailsResponse details(String placeId, String fields, String sessionToken, String clientTraceId) {
        long serviceStart = System.nanoTime();
        String normalizedPlaceId = normalizePlaceId(placeId);
        String fieldMask = canonicalFieldMask(fields);
        String normalizedSessionToken = normalizeSessionToken(sessionToken);
        String traceId = PlaceDetailsTimingLog.trace(clientTraceId);
        OffsetDateTime now = OffsetDateTime.now(clock);
        PlaceDetailsCacheId cacheId = new PlaceDetailsCacheId(normalizedPlaceId, fieldMask);
        long cacheLookupStart = System.nanoTime();
        Optional<PlaceDetailsCache> cached = cacheRepository.findById(cacheId);
        long cacheLookupMs = PlaceDetailsTimingLog.elapsedMs(cacheLookupStart);
        boolean cacheFresh = cached.isPresent() && cached.get().getExpiresAt().isAfter(now);
        log.info("{} cache.lookup trace={} place={} fields={} hit={} fresh={} durationMs={}",
            PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId,
            PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), cached.isPresent(), cacheFresh, cacheLookupMs);

        if (cacheFresh) {
            log.info("{} cache.hit trace={} place={} fields={} serviceMs={}",
                PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId,
                PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), PlaceDetailsTimingLog.elapsedMs(serviceStart));
            return new PlaceDetailsResponse(normalizedPlaceId, fieldMask, "cache", false, cached.get().getDetailsJson());
        }

        if (cached.isPresent()) {
            log.info("{} cache.expired trace={} place={} fields={}",
                PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId, PlaceDetailsTimingLog.fieldMaskSummary(fieldMask));
        } else {
            log.info("{} cache.miss trace={} place={} fields={}",
                PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId, PlaceDetailsTimingLog.fieldMaskSummary(fieldMask));
        }

        JsonNode freshDetails;
        long googleApiStart = System.nanoTime();
        try {
            freshDetails = googleClient.fetchDetails(normalizedPlaceId, fieldMask, normalizedSessionToken);
            log.info("{} google.done trace={} place={} fields={} durationMs={}",
                PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId,
                PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), PlaceDetailsTimingLog.elapsedMs(googleApiStart));
        } catch (PlaceDetailsException ex) {
            log.warn("{} google.error trace={} place={} fields={} slug={} durationMs={}",
                PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId,
                PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), ex.slug(), PlaceDetailsTimingLog.elapsedMs(googleApiStart));
            if (cached.isPresent()) {
                log.info("{} cache.stale trace={} place={} fields={} serviceMs={}",
                    PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId,
                    PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), PlaceDetailsTimingLog.elapsedMs(serviceStart));
                return new PlaceDetailsResponse(normalizedPlaceId, fieldMask, "stale_cache", true,
                    cached.get().getDetailsJson());
            }
            throw ex;
        }

        OffsetDateTime expiresAt = now.plus(ttlFor(fieldMask));
        PlaceDetailsCache cacheRow = cached.orElseGet(() ->
            new PlaceDetailsCache(normalizedPlaceId, fieldMask, freshDetails, now, expiresAt));
        cacheRow.update(freshDetails, now, expiresAt);
        saveCacheAsync(cacheRow, traceId, normalizedPlaceId, fieldMask);
        log.info("{} service.done trace={} place={} fields={} source=google serviceMs={}",
            PlaceDetailsTimingLog.PREFIX, traceId, normalizedPlaceId,
            PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), PlaceDetailsTimingLog.elapsedMs(serviceStart));
        return new PlaceDetailsResponse(normalizedPlaceId, fieldMask, "google", false, freshDetails);
    }

    private void saveCacheAsync(PlaceDetailsCache cacheRow, String traceId, String placeId, String fieldMask) {
        log.info("{} cache.save.queued trace={} place={} fields={}",
            PlaceDetailsTimingLog.PREFIX, traceId, placeId, PlaceDetailsTimingLog.fieldMaskSummary(fieldMask));
        try {
            cacheSaveExecutor.execute(() -> {
                long cacheSaveStart = System.nanoTime();
                try {
                    cacheRepository.save(cacheRow);
                    log.info("{} cache.save.done trace={} place={} fields={} durationMs={}",
                        PlaceDetailsTimingLog.PREFIX, traceId, placeId,
                        PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), PlaceDetailsTimingLog.elapsedMs(cacheSaveStart));
                } catch (RuntimeException ex) {
                    log.warn("{} cache.save.error trace={} place={} fields={} error={}",
                        PlaceDetailsTimingLog.PREFIX, traceId, placeId,
                        PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), ex.getClass().getSimpleName());
                }
            });
        } catch (RuntimeException ex) {
            log.warn("{} cache.save.rejected trace={} place={} fields={} error={}",
                PlaceDetailsTimingLog.PREFIX, traceId, placeId,
                PlaceDetailsTimingLog.fieldMaskSummary(fieldMask), ex.getClass().getSimpleName());
        }
    }

    static String canonicalFieldMask(String fields) {
        LinkedHashSet<String> fieldSet = new LinkedHashSet<>(DEFAULT_FIELDS);
        if (fields != null && !fields.isBlank()) {
            for (String rawField : fields.split(",")) {
                String field = rawField.strip();
                if (field.isEmpty()) continue;
                if (!ALLOWED_FIELDS.contains(field)) {
                    throw PlaceDetailsException.badRequest("Unsupported Google Place Details field: " + field);
                }
                fieldSet.add(field);
            }
        }

        LinkedHashSet<String> ordered = new LinkedHashSet<>();
        DEFAULT_FIELDS.stream().filter(fieldSet::contains).forEach(ordered::add);
        EXPANDED_FIELDS.stream().filter(fieldSet::contains).forEach(ordered::add);
        return String.join(",", ordered);
    }

    private static String normalizePlaceId(String placeId) {
        String normalized = placeId == null ? "" : placeId.strip();
        if (normalized.isEmpty()) {
            throw PlaceDetailsException.badRequest("Google Place ID is required");
        }
        return normalized;
    }

    private static String normalizeSessionToken(String sessionToken) {
        String normalized = sessionToken == null ? "" : sessionToken.strip();
        if (normalized.length() > 128) {
            throw PlaceDetailsException.badRequest("Google autocomplete session token is too long");
        }
        return normalized.isEmpty() ? null : normalized;
    }

    private Duration ttlFor(String fieldMask) {
        boolean hasExpandedFields = EXPANDED_FIELDS.stream()
            .anyMatch(field -> fieldMask.contains(field));
        AppProperties.PlaceDetails config = appProperties.getPlaceDetails();
        return hasExpandedFields ? config.getExpandedTtl() : config.getBasicTtl();
    }

    private static Set<String> buildAllowedFields() {
        LinkedHashSet<String> fields = new LinkedHashSet<>();
        fields.addAll(DEFAULT_FIELDS);
        fields.addAll(EXPANDED_FIELDS);
        return fields;
    }
}
