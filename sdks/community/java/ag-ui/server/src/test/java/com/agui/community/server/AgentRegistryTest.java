package com.agui.community.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.agent.Agent;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class AgentRegistryTest {

    private static final Agent A = input -> subscriber -> { };
    private static final Agent B = input -> subscriber -> { };

    @Test
    void findResolvesByIdAndMissesUnknown() {
        AgentRegistry registry = AgentRegistry.of(Map.of("a", A, "b", B));

        assertEquals(A, registry.find("a").orElseThrow());
        assertEquals(B, registry.find("b").orElseThrow());
        assertTrue(registry.find("nope").isEmpty());
        assertEquals(Set.of("a", "b"), registry.ids());
    }

    @Test
    void singleReturnsSoleAgentOnlyWhenExactlyOne() {
        assertEquals(A, AgentRegistry.of(Map.of("only", A)).single().orElseThrow());
        assertTrue(AgentRegistry.of(Map.of()).single().isEmpty());
        assertTrue(AgentRegistry.of(Map.of("a", A, "b", B)).single().isEmpty());
    }

    @Test
    void ofCopiesDefensivelyAndIsUnmodifiable() {
        Map<String, Agent> source = new HashMap<>();
        source.put("a", A);
        AgentRegistry registry = AgentRegistry.of(source);

        source.put("b", B);

        assertTrue(registry.find("b").isEmpty(), "later mutation must not leak in");
        assertFalse(registry.ids().isEmpty());
        assertThrows(UnsupportedOperationException.class, () -> registry.ids().add("x"));
    }

    @Test
    void ofRejectsNullMap() {
        assertThrows(NullPointerException.class, () -> AgentRegistry.of(null));
    }
}
