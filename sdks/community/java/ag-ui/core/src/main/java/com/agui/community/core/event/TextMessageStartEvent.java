package com.agui.community.core.event;

import com.agui.community.core.message.Role;
import java.util.Objects;

/**
 * Signals the start of a streamed text message.
 *
 * @param messageId the unique message identifier (required)
 * @param role      the role of the sender (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record TextMessageStartEvent(String messageId, Role role, Long timestamp, Object rawEvent)
        implements Event {

    public TextMessageStartEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
        Objects.requireNonNull(role, "role must not be null");
    }

    /**
     * Creates a text-message-start event with the required fields.
     *
     * @param messageId the unique message identifier
     * @param role      the role of the sender
     */
    public TextMessageStartEvent(String messageId, Role role) {
        this(messageId, role, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TEXT_MESSAGE_START;
    }
}
