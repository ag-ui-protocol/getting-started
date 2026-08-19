package com.agui.community.core.event;

import java.util.Objects;

/**
 * Carries a chunk of streamed text message content.
 *
 * @param messageId the message identifier, matching the
 *                  {@link TextMessageStartEvent} (required)
 * @param delta     a non-empty chunk of text (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record TextMessageContentEvent(String messageId, String delta, Long timestamp, Object rawEvent)
        implements Event {

    public TextMessageContentEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
        Objects.requireNonNull(delta, "delta must not be null");
        if (delta.isEmpty()) {
            throw new IllegalArgumentException("delta must not be empty");
        }
    }

    /**
     * Creates a text-message-content event with the required fields.
     *
     * @param messageId the message identifier
     * @param delta     a non-empty chunk of text
     */
    public TextMessageContentEvent(String messageId, String delta) {
        this(messageId, delta, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TEXT_MESSAGE_CONTENT;
    }
}
