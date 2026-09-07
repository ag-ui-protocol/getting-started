package com.agui.adk.endpoint;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class HeaderExtractionTest {

    @Test
    void stripsXPrefixAndConvertsHyphensToUnderscores() {
        assertThat(HeaderExtraction.headerToKey("x-user-id")).isEqualTo("user_id");
        assertThat(HeaderExtraction.headerToKey("X-User-Id")).isEqualTo("user_id");
        assertThat(HeaderExtraction.headerToKey("x-tenant-id")).isEqualTo("tenant_id");
    }

    @Test
    void leavesNonPrefixedHeadersWithHyphensConverted() {
        assertThat(HeaderExtraction.headerToKey("authorization")).isEqualTo("authorization");
        assertThat(HeaderExtraction.headerToKey("My-Header")).isEqualTo("my_header");
        assertThat(HeaderExtraction.headerToKey("api-key")).isEqualTo("api_key");
    }

    @Test
    void upperCaseXPrefixIsStrippedAndLowerCased() {
        assertThat(HeaderExtraction.headerToKey("X-API-KEY")).isEqualTo("api_key");
    }

    @Test
    void bareXPRefixYieldsEmptyKey() {
        assertThat(HeaderExtraction.headerToKey("x-")).isEmpty();
    }
}
