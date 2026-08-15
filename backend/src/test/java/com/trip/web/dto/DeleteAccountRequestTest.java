package com.trip.web.dto;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class DeleteAccountRequestTest {

    @Test
    void toStringRedactsCurrentPassword() {
        DeleteAccountRequest request = new DeleteAccountRequest("sensitive-value");

        assertThat(request.toString())
            .isEqualTo("DeleteAccountRequest[currentPassword=<redacted>]")
            .doesNotContain(request.currentPassword());
    }
}
