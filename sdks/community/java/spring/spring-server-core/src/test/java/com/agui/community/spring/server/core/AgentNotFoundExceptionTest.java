package com.agui.community.spring.server.core;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class AgentNotFoundExceptionTest {

    @Test
    void byIdMentionsTheMissingId() {
        assertTrue(AgentNotFoundException.byId("weather").getMessage().contains("weather"));
    }

    @Test
    void noSingleAgentDescribesTheCondition() {
        assertTrue(AgentNotFoundException.noSingleAgent().getMessage().toLowerCase().contains("default"));
    }
}
