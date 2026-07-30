package com.trip.web.dto.share;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record AcceptGuestShareLinkBodyRequest(
    @NotBlank(message = "token is required")
    @Pattern(regexp = "[A-Za-z0-9_-]{20,200}", message = "token format is invalid")
    String token,

    @NotBlank(message = "displayName is required")
    @Size(max = 200, message = "displayName must not exceed 200 characters")
    String displayName
) {
    @Override
    public String toString() {
        return "AcceptGuestShareLinkBodyRequest[token=<redacted>, displayName=<redacted>]";
    }
}
