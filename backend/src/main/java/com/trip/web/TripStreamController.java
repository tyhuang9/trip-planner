package com.trip.web;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.trip.config.AppProperties;
import com.trip.config.RateLimitFilter;
import com.trip.service.realtime.TripEventBroker;
import com.trip.service.trip.ResolvedTrip;
import com.trip.service.trip.TripActor;
import com.trip.service.trip.TripAccessGuard;
import com.trip.web.auth.AuthenticationActors;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.Pattern;

/**
 * Authenticated SSE stream for realtime trip invalidation events.
 */
@RestController
@RequestMapping("/api")
@Validated
public class TripStreamController {

    static final String PUBLIC_ID_PATTERN = "[a-z0-9]{1,24}";
    public static final String STREAM_CLIENT_HEADER = "X-Dupert-Stream-Client";
    static final String STREAM_CLIENT_PATTERN = "[A-Za-z0-9._~-]{16,64}";

    private final TripAccessGuard tripAccessGuard;
    private final TripEventBroker tripEventBroker;
    private final boolean trustProxy;

    public TripStreamController(TripAccessGuard tripAccessGuard,
                                TripEventBroker tripEventBroker,
                                AppProperties appProperties) {
        this.tripAccessGuard = tripAccessGuard;
        this.tripEventBroker = tripEventBroker;
        this.trustProxy = appProperties.isTrustProxy();
    }

    @GetMapping(path = "/trips/{publicId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamTrip(
            @PathVariable @Pattern(regexp = PUBLIC_ID_PATTERN) String publicId,
            @RequestHeader(name = STREAM_CLIENT_HEADER, required = false)
            @Pattern(regexp = STREAM_CLIENT_PATTERN) String streamClientId,
            Authentication authentication,
            HttpServletRequest request) {
        TripActor actor = AuthenticationActors.requireTripActor(authentication);
        ResolvedTrip resolved = tripAccessGuard.resolveForActor(publicId, actor);
        return tripEventBroker.subscribe(
            resolved.trip().getId(),
            streamActorKey(actor),
            RateLimitFilter.clientIp(request, trustProxy),
            streamClientId);
    }

    private static String streamActorKey(TripActor actor) {
        if (actor.isUser()) {
            return "user:" + actor.userId();
        }
        return "guest:" + sha256Hex(actor.guestSessionToken());
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is not available", ex);
        }
    }
}
