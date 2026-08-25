package com.agui.community.core.event;

import com.agui.community.core.message.Role;
import java.util.Objects;

/**
 * Carries the result of an executed tool call, to be appended to the
 * conversation as a tool message.
 *
 * @param messageId  the conversation message id for the result (required)
 * @param toolCallId the tool call identifier, matching the
 *                   {@link ToolCallStartEvent} (required)
 * @param content    the tool execution result/output (required)
 * @param role       the role of the message, typically {@link Role#TOOL}, or
 *                   {@code null} (optional)
 * @param timestamp  the event creation time in epoch milliseconds, or
 *                   {@code null} (optional)
 * @param rawEvent   the original event this was transformed from, or
 *                   {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ToolCallResultEvent(String messageId, String toolCallId, String content, Role role,
                                  Long timestamp, Object rawEvent) implements Event {

    public ToolCallResultEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
        Objects.requireNonNull(toolCallId, "toolCallId must not be null");
        Objects.requireNonNull(content, "content must not be null");
    }

    /**
     * Creates a tool-call-result event with the required fields.
     *
     * @param messageId  the conversation message id for the result
     * @param toolCallId the tool call identifier
     * @param content    the tool execution result/output
     */
    public ToolCallResultEvent(String messageId, String toolCallId, String content) {
        this(messageId, toolCallId, content, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.TOOL_CALL_RESULT;
    }
}
