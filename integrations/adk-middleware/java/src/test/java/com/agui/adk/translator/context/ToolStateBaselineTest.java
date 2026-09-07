package com.agui.adk.translator.context;

import com.agui.community.core.event.CustomEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class ToolStateBaselineTest {

    private ToolState toolState;

    @BeforeEach
    void setUp() {
        toolState = new ToolState();
    }

    @Test
    void shouldTrackActiveToolsCorrectly_throughLifecycle() {
        String toolCallId = "activeTool-123";

        assertFalse(toolState.isActive(toolCallId), "Should not be active initially");

        // Start tracking
        toolState.startTrackingToolCall(toolCallId);
        assertTrue(toolState.isActive(toolCallId), "Should be active after starting");

        // End tracking
        toolState.endTrackingToolCall(toolCallId);
        assertFalse(toolState.isActive(toolCallId), "Should not be active after ending");
    }

    @Test
    void shouldTrackPredictiveStateToolsCorrectly_whenAdded() {
        String toolCallId = "predictiveTool-123";

        assertFalse(toolState.isPredictiveStateTool(toolCallId), "Should not be predictive initially");

        toolState.addPredictiveStateToolCallId(toolCallId);
        assertTrue(toolState.isPredictiveStateTool(toolCallId), "Should be predictive after being added");
    }

    @Test
    void shouldTrackLongRunningToolsCorrectly_whenPopulated() {
        String lroToolId1 = "lro-1";
        String lroToolId2 = "lro-2";
        String normalToolId = "normal-1";
        Set<String> lroIds = Set.of(lroToolId1, lroToolId2);

        assertFalse(toolState.isLongRunningTool(lroToolId1), "Should not be long-running initially");

        toolState.populateLongRunningToolIds(lroIds);

        assertTrue(toolState.isLongRunningTool(lroToolId1));
        assertTrue(toolState.isLongRunningTool(lroToolId2));
        assertFalse(toolState.isLongRunningTool(normalToolId));
    }

    @Test
    void shouldManageDeferredEventsCorrectly_throughLifecycle() {
        assertTrue(toolState.getAndClearDeferredEvents().isEmpty(), "Should be empty initially");

        com.agui.community.core.event.Event event1 = new CustomEvent("first", "value-1");
        com.agui.community.core.event.Event event2 = new CustomEvent("second", "value-2");
        List<com.agui.community.core.event.Event> eventsToAdd = List.of(event1, event2);

        toolState.addDeferredConfirmEvents(eventsToAdd);

        assertTrue(toolState.hasDeferredConfirmEvents(), "hasDeferredConfirmEvents true after add");
        List<com.agui.community.core.event.Event> retrievedEvents = toolState.getAndClearDeferredEvents();
        assertEquals(2, retrievedEvents.size());
        assertTrue(retrievedEvents.contains(event1));
        assertTrue(retrievedEvents.contains(event2));

        assertFalse(toolState.hasDeferredConfirmEvents(), "hasDeferredConfirmEvents false after clear");
        assertTrue(toolState.getAndClearDeferredEvents().isEmpty(), "Should be empty after getting and clearing");
    }
}
