package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals the end of a streamed reasoning message. The {@link #messageId()}
 * matches the corresponding {@link ReasoningMessageStartEvent}.
 *
 * @param messageId the message identifier (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningMessageEndEvent(String messageId, Long timestamp, Object rawEvent)
        implements Event {

    public ReasoningMessageEndEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
    }

    /**
     * Creates a reasoning-message-end event from a message id.
     *
     * @param messageId the message identifier
     */
    public ReasoningMessageEndEvent(String messageId) {
        this(messageId, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_MESSAGE_END;
    }
}
