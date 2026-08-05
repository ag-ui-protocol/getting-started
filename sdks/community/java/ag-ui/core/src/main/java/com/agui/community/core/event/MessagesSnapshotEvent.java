package com.agui.community.core.event;

import com.agui.community.core.message.Message;
import java.util.List;
import java.util.Objects;

/**
 * Carries a complete snapshot of the conversation messages.
 *
 * @param messages  the full list of conversation messages; never {@code null}
 *                  (required, copied to an unmodifiable list)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record MessagesSnapshotEvent(List<Message> messages, Long timestamp, Object rawEvent)
        implements Event {

    public MessagesSnapshotEvent {
        Objects.requireNonNull(messages, "messages must not be null");
        messages = List.copyOf(messages);
    }

    /**
     * Creates a messages-snapshot event from a list of messages.
     *
     * @param messages the full list of conversation messages
     */
    public MessagesSnapshotEvent(List<Message> messages) {
        this(messages, null, null);
    }

    @Override
    public EventType type() {
        return EventType.MESSAGES_SNAPSHOT;
    }
}
