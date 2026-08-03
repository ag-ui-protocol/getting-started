package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals the start of a streamed reasoning message.
 *
 * @param messageId the unique message identifier (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningMessageStartEvent(String messageId, Long timestamp, Object rawEvent)
        implements Event {

    public ReasoningMessageStartEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
    }

    /**
     * Creates a reasoning-message-start event from a message id.
     *
     * @param messageId the unique message identifier
     */
    public ReasoningMessageStartEvent(String messageId) {
        this(messageId, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_MESSAGE_START;
    }
}
