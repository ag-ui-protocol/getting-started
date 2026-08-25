package com.agui.community.core.event;

import java.util.Objects;

/**
 * A self-contained chunk of a reasoning message that combines start, content
 * and end semantics. An empty or {@code null} {@link #delta()} closes the
 * message.
 *
 * @param messageId the message identifier (required)
 * @param delta     a chunk of reasoning text; empty closes the message, or
 *                  {@code null} (optional)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningMessageChunkEvent(String messageId, String delta, Long timestamp,
                                         Object rawEvent) implements Event {

    public ReasoningMessageChunkEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
    }

    /**
     * Creates a reasoning-message-chunk event with a message id and delta.
     *
     * @param messageId the message identifier
     * @param delta     a chunk of reasoning text
     */
    public ReasoningMessageChunkEvent(String messageId, String delta) {
        this(messageId, delta, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_MESSAGE_CHUNK;
    }
}
