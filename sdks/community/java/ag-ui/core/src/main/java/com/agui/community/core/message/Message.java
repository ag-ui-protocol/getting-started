package com.agui.community.core.message;

/**
 * A single message in an AG-UI conversation.
 *
 * <p>This is a sealed type: every message has an {@link #id()} and a
 * {@link #role()}, and is one of the concrete message types permitted below.
 * Use a {@code switch} on the implementation type to handle each variant
 * exhaustively.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/messages">AG-UI Messages</a>
 */
public sealed interface Message
        permits DeveloperMessage, SystemMessage, AssistantMessage, UserMessage, ToolMessage {

    /**
     * @return the unique identifier of this message (required)
     */
    String id();

    /**
     * @return the role of the participant that produced this message
     */
    Role role();

    /**
     * @return the textual content of this message, or {@code null} when absent
     *         (content is optional on {@link AssistantMessage})
     */
    String content();
}
