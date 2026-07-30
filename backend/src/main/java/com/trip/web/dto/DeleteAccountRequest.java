package com.trip.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record DeleteAccountRequest(
    @NotBlank
    @Size(max = 128)
    String currentPassword
) {
    @Override
    public String toString() {
        return "DeleteAccountRequest[currentPassword=<redacted>]";
    }
}
