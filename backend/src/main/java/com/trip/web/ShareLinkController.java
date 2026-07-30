package com.trip.web;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.trip.service.share.ShareLinkService;
import com.trip.web.auth.AuthenticationActors;
import com.trip.web.auth.GuestSessionCookie;
import com.trip.web.dto.share.AcceptGuestShareLinkBodyRequest;
import com.trip.web.dto.share.AcceptGuestShareLinkRequest;
import com.trip.web.dto.share.AcceptGuestShareLinkResponse;
import com.trip.web.dto.share.AcceptShareLinkRequest;
import com.trip.web.dto.share.AcceptShareLinkResponse;
import com.trip.web.dto.share.CreateShareLinkRequest;
import com.trip.web.dto.share.CreateShareLinkResponse;
import com.trip.web.dto.share.RenameShareLinkRequest;
import com.trip.web.dto.share.ShareLinkResponse;
import com.trip.web.dto.trip.TripResponse;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import jakarta.servlet.http.HttpServletResponse;

@RestController
@Validated
public class ShareLinkController {

    static final String PUBLIC_ID_PATTERN = TripController.PUBLIC_ID_PATTERN;
    static final String SHARE_TOKEN_PATTERN = "[A-Za-z0-9_-]{20,200}";

    private final ShareLinkService shareLinkService;
    private final GuestSessionCookie guestSessionCookie;

    public ShareLinkController(ShareLinkService shareLinkService,
                               GuestSessionCookie guestSessionCookie) {
        this.shareLinkService = shareLinkService;
        this.guestSessionCookie = guestSessionCookie;
    }

    @PostMapping("/api/trips/{publicId}/share-links")
    public ResponseEntity<CreateShareLinkResponse> create(
            @PathVariable @Pattern(regexp = PUBLIC_ID_PATTERN) String publicId,
            @Valid @RequestBody CreateShareLinkRequest body,
            Authentication authentication) {
        Long userId = AuthenticationActors.requireUserId(authentication);
        return ResponseEntity.status(HttpStatus.CREATED)
            .body(shareLinkService.create(publicId, userId, body));
    }

    @GetMapping("/api/trips/{publicId}/share-links")
    public ResponseEntity<List<ShareLinkResponse>> list(
            @PathVariable @Pattern(regexp = PUBLIC_ID_PATTERN) String publicId,
            Authentication authentication) {
        Long userId = AuthenticationActors.requireUserId(authentication);
        return ResponseEntity.ok(shareLinkService.list(publicId, userId));
    }

    @DeleteMapping("/api/trips/{publicId}/share-links/{linkId}")
    public ResponseEntity<Void> revoke(
            @PathVariable @Pattern(regexp = PUBLIC_ID_PATTERN) String publicId,
            @PathVariable Long linkId,
            Authentication authentication) {
        Long userId = AuthenticationActors.requireUserId(authentication);
        shareLinkService.revoke(publicId, userId, linkId);
        return ResponseEntity.noContent().build();
    }

    @PatchMapping("/api/trips/{publicId}/share-links/{linkId}")
    public ResponseEntity<ShareLinkResponse> rename(
            @PathVariable @Pattern(regexp = PUBLIC_ID_PATTERN) String publicId,
            @PathVariable Long linkId,
            @Valid @RequestBody RenameShareLinkRequest body,
            Authentication authentication) {
        Long userId = AuthenticationActors.requireUserId(authentication);
        return ResponseEntity.ok(shareLinkService.rename(publicId, userId, linkId, body.name()));
    }

    @PostMapping("/api/share/accept")
    public ResponseEntity<AcceptShareLinkResponse> acceptForUser(
            @Valid @RequestBody AcceptShareLinkRequest body,
            Authentication authentication) {
        return acceptForUser(body.token(), authentication);
    }

    @PostMapping("/api/share/guest")
    public ResponseEntity<AcceptGuestShareLinkResponse> acceptForGuest(
            @Valid @RequestBody AcceptGuestShareLinkBodyRequest body,
            HttpServletResponse response) {
        return acceptForGuest(body.token(), body.displayName(), response);
    }

    /** Compatibility route for clients deployed before token body transport. */
    @Deprecated(forRemoval = true)
    @PostMapping("/api/share/{token}/accept")
    public ResponseEntity<AcceptShareLinkResponse> acceptForUserLegacy(
            @PathVariable @Pattern(regexp = SHARE_TOKEN_PATTERN) String token,
            Authentication authentication) {
        return acceptForUser(token, authentication);
    }

    /** Compatibility route for clients deployed before token body transport. */
    @Deprecated(forRemoval = true)
    @PostMapping("/api/share/{token}/guest")
    public ResponseEntity<AcceptGuestShareLinkResponse> acceptForGuestLegacy(
            @PathVariable @Pattern(regexp = SHARE_TOKEN_PATTERN) String token,
            @Valid @RequestBody AcceptGuestShareLinkRequest body,
            HttpServletResponse response) {
        return acceptForGuest(token, body.displayName(), response);
    }

    private ResponseEntity<AcceptShareLinkResponse> acceptForUser(
            String token,
            Authentication authentication) {
        Long userId = AuthenticationActors.requireUserId(authentication);
        return ResponseEntity.ok(shareLinkService.acceptForUser(token, userId));
    }

    private ResponseEntity<AcceptGuestShareLinkResponse> acceptForGuest(
            String token,
            String displayName,
            HttpServletResponse response) {
        ShareLinkService.AcceptedGuestSession accepted =
            shareLinkService.acceptForGuest(token, displayName);
        guestSessionCookie.addToResponse(response, accepted.rawGuestToken());
        return ResponseEntity.ok(accepted.response());
    }

    @PostMapping("/api/guest-session/claim")
    public ResponseEntity<TripResponse> claimGuestSession(
            @CookieValue(name = GuestSessionCookie.COOKIE_NAME, required = false) String rawGuestToken,
            Authentication authentication,
            HttpServletResponse response) {
        Long userId = AuthenticationActors.requireUserId(authentication);
        TripResponse trip = shareLinkService.claimGuestSession(rawGuestToken, userId);
        guestSessionCookie.clearOnResponse(response);
        return ResponseEntity.ok(trip);
    }
}
