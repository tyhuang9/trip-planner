package com.trip.web.dto.share;

import com.trip.domain.TripRole;

/** Safe launch projection; it deliberately excludes the raw guest credential. */
public record GuestSessionBootstrapResponse(
        String publicId,
        TripRole role,
        String displayName) {
}
