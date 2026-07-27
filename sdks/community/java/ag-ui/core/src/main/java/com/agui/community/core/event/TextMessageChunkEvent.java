package com.agui.community.core.event;

import com.agui.community.core.message.Role;

/**
 * A self-contained chunk of a text message that combines start, content and end
 * semantics. All fields are optional, though {@link #messageId()} is required on
 * the first chunk and {@link #role()} defaults to {@link Role#ASSISTANT}.
 *
 * @param messageId the message identifier (required on the first chunk), or
 *                  {@code null} (optional)
 * @param role      the role of the sender, or {@code null} to default to
 *                  {@link Role#ASSISTANT} (optional)
 * @param delta     a chunk of text, or {@code null} (optional)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record TextMessageChunkEvent(String messageId, Role role, String delta, Long timestamp,
                                    Object rawEvent) implements Event {

    /**
     * Creates a text-message-chunk event with a message id, role and delta.
     *
     * @param messageId the message identifier
     * @param role      the role of the sender
     * @param delta     a chunk of text
     */
    public TextMessageChunkEvent(String messageId, Role role, String delta) {
        this(messageId, role, delta, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TEXT_MESSAGE_CHUNK;
    }
}
