package com.agui.community.core.event;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import static org.junit.jupiter.api.Assertions.*;

class EventTest {

    @ParameterizedTest
    @EnumSource(EventType.class)
    void eventTypeValueRoundTrips(EventType type) {
        assertSame(type, EventType.fromValue(type.value()));
    }

    @Test
    void eventTypeFromValueRejectsUnknown() {
        assertThrows(IllegalArgumentException.class, () -> EventType.fromValue("NOPE"));
    }

    @Test
    void runStartedEventReportsItsType() {
        RunStartedEvent event = new RunStartedEvent("thread-1", "run-1");
        assertEquals(EventType.RUN_STARTED, event.type());
        assertEquals("thread-1", event.threadId());
        assertEquals("run-1", event.runId());
        assertNull(event.parentRunId());
        assertNull(event.timestamp());
    }

    @Test
    void runStartedEventRequiresThreadAndRunId() {
        assertThrows(NullPointerException.class, () -> new RunStartedEvent(null, "run-1"));
        assertThrows(NullPointerException.class, () -> new RunStartedEvent("thread-1", null));
    }

    @Test
    void textMessageContentReportsItsType() {
        TextMessageContentEvent event = new TextMessageContentEvent("m1", "hello");
        assertEquals(EventType.TEXT_MESSAGE_CONTENT, event.type());
        assertEquals("hello", event.delta());
    }

    @Test
    void textMessageContentRejectsEmptyDelta() {
        assertThrows(IllegalArgumentException.class, () -> new TextMessageContentEvent("m1", ""));
    }

    @Test
    void textMessageContentRejectsNulls() {
        assertThrows(NullPointerException.class, () -> new TextMessageContentEvent(null, "hi"));
        assertThrows(NullPointerException.class, () -> new TextMessageContentEvent("m1", null));
    }

    @Test
    void eventsExposeSealedHierarchy() {
        Event event = new RunStartedEvent("t", "r");
        assertInstanceOf(RunStartedEvent.class, event);
        assertEquals(EventType.RUN_STARTED, event.type());
    }
}
