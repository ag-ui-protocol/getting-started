package com.agui.adk.endpoint;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ExtractorStateMergerTest {

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void mergeStateExtractsOverExisting() {
        Map<String, Object> existing = map("a", "1", "b", "2");
        Map<String, Object> extracted = map("b", "3", "c", "4");
        Map<String, Object> merged = ExtractorStateMerger.mergeState(existing, extracted);
        assertThat(merged).isEqualTo(map("a", "1", "b", "3", "c", "4"));
    }

    @Test
    void mergeStateKeepsExistingKeyPosition() {
        Map<String, Object> merged = ExtractorStateMerger.mergeState(
                map("a", "1", "b", "2"), map("b", "9"));
        assertThat(new java.util.ArrayList<>(merged.keySet()))
                .containsExactly("a", "b");
        assertThat(merged.get("b")).isEqualTo("9");
    }

    @Test
    void mergeStateTreatsNullAsEmpty() {
        assertThat(ExtractorStateMerger.mergeState(null, null)).isEmpty();
        assertThat(ExtractorStateMerger.mergeState(map("a", "1"), null))
                .isEqualTo(map("a", "1"));
    }

    @Test
    void extractHeadersBuildsStateHeadersKey() {
        Map<String, String> req = new LinkedHashMap<>();
        req.put("x-user-id", "bob");
        Map<String, Object> state = ExtractorStateMerger.extractHeadersState(
                List.of("x-user-id"), req, null);
        assertThat(state).isEqualTo(map("headers", map("user_id", "bob")));
    }

    @Test
    void extractHeadersClientHeadersTakePrecedence() {
        Map<String, String> req = new LinkedHashMap<>();
        req.put("x-tenant-id", "extracted-tenant");
        Map<String, Object> input = map("headers", map("tenant_id", "client-tenant"),
                "other", "v");
        Map<String, Object> state = ExtractorStateMerger.extractHeadersState(
                List.of("x-tenant-id"), req, input);
        Map<String, Object> headers = (Map<String, Object>) state.get("headers");
        assertThat(headers.get("tenant_id")).isEqualTo("client-tenant"); // client wins
        assertThat(state.get("other")).isEqualTo("v");                   // existing preserved
    }

    @Test
    void extractHeadersReturnsEmptyWhenNothingExtracted() {
        Map<String, String> req = new LinkedHashMap<>();
        req.put("x-user-id", "bob");
        assertThat(ExtractorStateMerger.extractHeadersState(
                List.of("x-missing"), req, null)).isEmpty();
        assertThat(ExtractorStateMerger.extractHeadersState(null, req, null)).isEmpty();
    }
}
