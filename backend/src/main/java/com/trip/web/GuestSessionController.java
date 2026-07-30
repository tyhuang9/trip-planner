package com.trip.web;

import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import com.trip.service.share.GuestSessionAccessService;
import com.trip.web.auth.AuthenticationActors;
import com.trip.web.auth.GuestSessionCookie;
import com.trip.web.dto.share.GuestSessionBootstrapResponse;
import com.trip.web.exception.NotFoundException;

import jakarta.servlet.http.HttpServletResponse;

@RestController
public class GuestSessionController {

    private final GuestSessionAccessService guestSessionAccessService;
    private final GuestSessionCookie guestSessionCookie;

    public GuestSessionController(GuestSessionAccessService guestSessionAccessService,
                                  GuestSessionCookie guestSessionCookie) {
        this.guestSessionAccessService = guestSessionAccessService;
        this.guestSessionCookie = guestSessionCookie;
    }

    @GetMapping("/api/guest-session/bootstrap")
    public ResponseEntity<GuestSessionBootstrapResponse> bootstrap(
            Authentication authentication,
            HttpServletResponse response) {
        var rawGuestToken = AuthenticationActors.guestToken(authentication);
        if (rawGuestToken.isEmpty()) {
            return ResponseEntity.noContent().build();
        }

        try {
            var restored = guestSessionAccessService.restore(rawGuestToken.get());
            return ResponseEntity.ok(new GuestSessionBootstrapResponse(
                restored.publicId(), restored.role(), restored.displayName()));
        } catch (NotFoundException inactive) {
            guestSessionCookie.clearOnResponse(response);
            return ResponseEntity.noContent().build();
        }
    }
}
