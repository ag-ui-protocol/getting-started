package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals the end of a streamed tool call.
 *
 * @param toolCallId the tool call identifier, matching the
 *                   {@link ToolCallStartEvent} (required)
 * @param timestamp  the event creation time in epoch milliseconds, or
 *                   {@code null} (optional)
 * @param rawEvent   the original event this was transformed from, or
 *                   {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ToolCallEndEvent(String toolCallId, Long timestamp, Object rawEvent)
        implements Event {

    public ToolCallEndEvent {
        Objects.requireNonNull(toolCallId, "toolCallId must not be null");
    }

    /**
     * Creates a tool-call-end event from a tool call id.
     *
     * @param toolCallId the tool call identifier
     */
    public ToolCallEndEvent(String toolCallId) {
        this(toolCallId, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TOOL_CALL_END;
    }
}
