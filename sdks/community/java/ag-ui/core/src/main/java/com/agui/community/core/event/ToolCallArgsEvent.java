package com.agui.community.core.event;

import java.util.Objects;

/**
 * Carries a chunk of streamed tool call arguments.
 *
 * @param toolCallId the tool call identifier, matching the
 *                   {@link ToolCallStartEvent} (required)
 * @param delta      a chunk of the (JSON-encoded) argument data (required)
 * @param timestamp  the event creation time in epoch milliseconds, or
 *                   {@code null} (optional)
 * @param rawEvent   the original event this was transformed from, or
 *                   {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ToolCallArgsEvent(String toolCallId, String delta, Long timestamp, Object rawEvent)
        implements Event {

    public ToolCallArgsEvent {
        Objects.requireNonNull(toolCallId, "toolCallId must not be null");
        Objects.requireNonNull(delta, "delta must not be null");
    }

    /**
     * Creates a tool-call-args event with the required fields.
     *
     * @param toolCallId the tool call identifier
     * @param delta      a chunk of the argument data
     */
    public ToolCallArgsEvent(String toolCallId, String delta) {
        this(toolCallId, delta, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TOOL_CALL_ARGS;
    }
}
