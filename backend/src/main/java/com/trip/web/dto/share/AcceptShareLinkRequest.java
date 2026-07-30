package com.trip.web.dto.share;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

public record AcceptShareLinkRequest(
    @NotBlank(message = "token is required")
    @Pattern(regexp = "[A-Za-z0-9_-]{20,200}", message = "token format is invalid")
    String token
) {
    @Override
    public String toString() {
        return "AcceptShareLinkRequest[token=<redacted>]";
    }
}
