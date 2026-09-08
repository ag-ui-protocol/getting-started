package com.agui.community.core.event;

import com.agui.community.core.message.Role;
import java.util.Objects;

/**
 * Signals the start of a streamed reasoning message.
 *
 * @param messageId the unique message identifier (required)
 * @param role      the role of the sender; always {@link Role#REASONING}
 *                  (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningMessageStartEvent(String messageId, Role role, Long timestamp, Object rawEvent)
        implements Event {

    public ReasoningMessageStartEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
        role = role == null ? Role.REASONING : role;
        if (role != Role.REASONING) {
            throw new IllegalArgumentException("role must be " + Role.REASONING + " but was " + role);
        }
    }

    /**
     * Creates a reasoning-message-start event from a message id, defaulting the
     * role to {@link Role#REASONING}.
     *
     * @param messageId the unique message identifier
     */
    public ReasoningMessageStartEvent(String messageId) {
        this(messageId, Role.REASONING, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_MESSAGE_START;
    }
}
