package com.agui.community.core.message;

import java.util.Objects;

/**
 * A reasoning (chain-of-thought) message produced by the assistant. Reasoning
 * messages carry intermediate thinking that a client may replay back to the
 * agent as part of the conversation history, so they must be representable
 * alongside the other {@link Message} variants.
 *
 * <p>When the upstream provider does not expose the reasoning in plain text it
 * is delivered as an encrypted blob; {@link #encryptedValue()} preserves that
 * blob so it survives a round trip through the conversation history (for
 * example {@code RunAgentInput.messages}).
 *
 * @param id             the unique identifier of this message (required)
 * @param content        the reasoning text of this message (required)
 * @param name           an optional name for the participant, or {@code null}
 * @param encryptedValue the encrypted chain-of-thought blob when the reasoning
 *                       is not exposed in plain text, or {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/messages">AG-UI Messages</a>
 */
public record ReasoningMessage(String id, String content, String name, String encryptedValue)
        implements Message {

    public ReasoningMessage {
        Objects.requireNonNull(id, "id must not be null");
        Objects.requireNonNull(content, "content must not be null");
    }

    /**
     * Creates a reasoning message without a name or encrypted value.
     *
     * @param id      the unique identifier of this message
     * @param content the reasoning text of this message
     */
    public ReasoningMessage(String id, String content) {
        this(id, content, null, null);
    }

    /**
     * Creates a reasoning message with a name but no encrypted value.
     *
     * @param id      the unique identifier of this message
     * @param content the reasoning text of this message
     * @param name    an optional name for the participant, or {@code null}
     */
    public ReasoningMessage(String id, String content, String name) {
        this(id, content, name, null);
    }

    @Override
    public Role role() {
        return Role.REASONING;
    }
}
