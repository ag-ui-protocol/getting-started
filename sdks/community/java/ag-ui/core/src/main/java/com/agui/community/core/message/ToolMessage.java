package com.agui.community.core.message;

import java.util.Objects;

/**
 * The result of a tool call, fed back into the conversation. Unlike the other
 * message types a tool message has no {@code name}; instead it references the
 * {@link #toolCallId()} of the {@link ToolCall} it answers.
 *
 * @param id         the unique identifier of this message (required)
 * @param content    the textual result of the tool call (required)
 * @param toolCallId the id of the {@link ToolCall} this message answers
 *                   (required)
 * @param error      an optional error message if the tool call failed, or
 *                   {@code null}
 * @see <a href="https://docs.ag-ui.com/concepts/messages">AG-UI Messages</a>
 */
public record ToolMessage(String id, String content, String toolCallId, String error)
        implements Message {

    public ToolMessage {
        Objects.requireNonNull(id, "id must not be null");
        Objects.requireNonNull(content, "content must not be null");
        Objects.requireNonNull(toolCallId, "toolCallId must not be null");
    }

    /**
     * Creates a successful tool message without an error.
     *
     * @param id         the unique identifier of this message
     * @param content    the textual result of the tool call
     * @param toolCallId the id of the tool call this message answers
     */
    public ToolMessage(String id, String content, String toolCallId) {
        this(id, content, toolCallId, null);
    }

    @Override
    public Role role() {
        return Role.TOOL;
    }
}
