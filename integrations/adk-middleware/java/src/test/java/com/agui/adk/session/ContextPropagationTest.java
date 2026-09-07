package com.agui.adk.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ContextPropagationTest {

    @Test
    void requestContextIsReplacedRatherThanMergedAcrossInvocations() {
        ClientStateStore stateStore = new ClientStateStore(new ObjectMapper());
        Map<String, Object> first = stateStore.persistContext(Map.of(), Map.of("user", "alice", "turn", 1));
        Map<String, Object> second = stateStore.persistContext(first, Map.of("user", "alice", "turn", 2));

        assertThat(stateStore.context(second)).containsOnly(Map.entry("user", "alice"), Map.entry("turn", 2));
        assertThat(stateStore.snapshot(second)).isEmpty();
    }
}
