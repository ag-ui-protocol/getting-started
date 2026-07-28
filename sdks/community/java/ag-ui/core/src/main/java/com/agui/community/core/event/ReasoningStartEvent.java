package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals the start of a reasoning (chain-of-thought) sequence.
 *
 * @param messageId the unique reasoning identifier (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningStartEvent(String messageId, Long timestamp, Object rawEvent)
        implements Event {

    public ReasoningStartEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
    }

    /**
     * Creates a reasoning-start event from a message id.
     *
     * @param messageId the unique reasoning identifier
     */
    public ReasoningStartEvent(String messageId) {
        this(messageId, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_START;
    }
}
