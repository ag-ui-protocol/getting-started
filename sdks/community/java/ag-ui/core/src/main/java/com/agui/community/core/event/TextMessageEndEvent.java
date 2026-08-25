package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals the end of a streamed text message.
 *
 * @param messageId the message identifier, matching the
 *                  {@link TextMessageStartEvent} (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record TextMessageEndEvent(String messageId, Long timestamp, Object rawEvent)
        implements Event {

    public TextMessageEndEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
    }

    /**
     * Creates a text-message-end event from a message id.
     *
     * @param messageId the message identifier
     */
    public TextMessageEndEvent(String messageId) {
        this(messageId, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TEXT_MESSAGE_END;
    }
}
