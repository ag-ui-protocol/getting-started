package com.agui.community.core.message;

import java.util.Objects;

/**
 * A reasoning (chain-of-thought) message produced by the assistant. Reasoning
 * messages carry intermediate thinking that a client may replay back to the
 * agent as part of the conversation history, so they must be representable
 * alongside the other {@link Message} variants.
 *
 * @param id      the unique identifier of this message (required)
 * @param content the reasoning text of this message (required)
 * @param name    an optional name for the participant, or {@code null}
 * @see <a href="https://docs.ag-ui.com/concepts/messages">AG-UI Messages</a>
 */
public record ReasoningMessage(String id, String content, String name) implements Message {

    public ReasoningMessage {
        Objects.requireNonNull(id, "id must not be null");
        Objects.requireNonNull(content, "content must not be null");
    }

    /**
     * Creates a reasoning message without a name.
     *
     * @param id      the unique identifier of this message
     * @param content the reasoning text of this message
     */
    public ReasoningMessage(String id, String content) {
        this(id, content, null);
    }

    @Override
    public Role role() {
        return Role.REASONING;
    }
}
