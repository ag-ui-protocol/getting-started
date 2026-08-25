package com.agui.community.core.event;

/**
 * A self-contained chunk of a tool call that combines start, args and end
 * semantics. {@link #toolCallId()} and {@link #toolCallName()} are required on
 * the first chunk; all fields are otherwise optional.
 *
 * @param toolCallId      the tool call identifier (required on the first
 *                        chunk), or {@code null} (optional)
 * @param toolCallName    the tool name (required on the first chunk), or
 *                        {@code null} (optional)
 * @param parentMessageId the id of the message this tool call belongs to, or
 *                        {@code null} (optional)
 * @param delta           a chunk of the argument data, or {@code null}
 *                        (optional)
 * @param timestamp       the event creation time in epoch milliseconds, or
 *                        {@code null} (optional)
 * @param rawEvent        the original event this was transformed from, or
 *                        {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ToolCallChunkEvent(String toolCallId, String toolCallName, String parentMessageId,
                                 String delta, Long timestamp, Object rawEvent) implements Event {

    /**
     * Creates a tool-call-chunk event with id, name and argument delta.
     *
     * @param toolCallId   the tool call identifier
     * @param toolCallName the tool name
     * @param delta        a chunk of the argument data
     */
    public ToolCallChunkEvent(String toolCallId, String toolCallName, String delta) {
        this(toolCallId, toolCallName, null, delta, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TOOL_CALL_CHUNK;
    }
}
