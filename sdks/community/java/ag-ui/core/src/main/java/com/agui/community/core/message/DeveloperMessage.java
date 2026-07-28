package com.agui.community.core.message;

import java.util.Objects;

/**
 * A message from the developer, typically carrying instructions for the agent.
 *
 * @param id      the unique identifier of this message (required)
 * @param content the textual content of this message (required)
 * @param name    an optional name for the participant, or {@code null}
 * @see <a href="https://docs.ag-ui.com/concepts/messages">AG-UI Messages</a>
 */
public record DeveloperMessage(String id, String content, String name) implements Message {

    public DeveloperMessage {
        Objects.requireNonNull(id, "id must not be null");
        Objects.requireNonNull(content, "content must not be null");
    }

    /**
     * Creates a developer message without a name.
     *
     * @param id      the unique identifier of this message
     * @param content the textual content of this message
     */
    public DeveloperMessage(String id, String content) {
        this(id, content, null);
    }

    @Override
    public Role role() {
        return Role.DEVELOPER;
    }
}
