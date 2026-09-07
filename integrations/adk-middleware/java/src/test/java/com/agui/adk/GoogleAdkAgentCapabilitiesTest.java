package com.agui.adk;

import com.agui.adk.message.MessageReservationStore;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class GoogleAdkAgentCapabilitiesTest {

    @Test
    void returnsNullWhenCapabilitiesAreNotConfigured() {
        SessionManager sessionManager = mock(SessionManager.class);
        GoogleAdkAgent agent = baseBuilder(sessionManager).build();

        assertThat(agent.capabilities()).isNull();
        verify(sessionManager).registerMessageReservationStore(any(MessageReservationStore.class));
    }

    @Test
    void returnsDeclaredCapabilitiesWithoutInjectingBridgeDiagnostics() {
        SessionManager sessionManager = mock(SessionManager.class);
        Map<String, Object> declared = Map.of(
                "predictiveChips", true,
                "tools", Map.of("namespaced", "ui_"),
                "vendor", Map.of("modes", List.of("strict", "safe")));
        GoogleAdkAgent agent = baseBuilder(sessionManager)
                .capabilities(declared)
                .build();

        assertThat(agent.capabilities()).isEqualTo(declared);
    }

    @Test
    @SuppressWarnings("unchecked")
    void returnsDeepCopyOfDeclaredCapabilities() {
        SessionManager sessionManager = mock(SessionManager.class);
        Map<String, Object> nested = new HashMap<>();
        nested.put("modes", new ArrayList<>(List.of("strict")));
        Map<String, Object> declared = new HashMap<>();
        declared.put("vendor", nested);
        GoogleAdkAgent agent = baseBuilder(sessionManager)
                .capabilities(declared)
                .build();

        nested.put("late", true);
        Map<String, Object> first = agent.capabilities();
        ((Map<String, Object>) first.get("vendor")).put("mutated", true);
        ((List<String>) ((Map<String, Object>) first.get("vendor")).get("modes")).add("unsafe");

        assertThat(agent.capabilities()).isEqualTo(Map.of(
                "vendor", Map.of("modes", List.of("strict"))));
    }

    @Test
    void rejectsNonJsonSerializableDeclaredCapabilities() {
        SessionManager sessionManager = mock(SessionManager.class);
        List<Object> cycle = new ArrayList<>();
        cycle.add(cycle);

        assertThatThrownBy(() -> baseBuilder(sessionManager).capabilities(Map.of("bad", cycle)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("capabilities must be JSON-serializable");
    }

    private static GoogleAdkAgent.Builder baseBuilder(SessionManager sessionManager) {
        return GoogleAdkAgent.builder()
                .runner(mock(AdkRunnerClient.class))
                .sessionManager(sessionManager)
                .userIdExtractor(input -> "test-user")
                .configuredBackendToolNames(Set.of());
    }
}
