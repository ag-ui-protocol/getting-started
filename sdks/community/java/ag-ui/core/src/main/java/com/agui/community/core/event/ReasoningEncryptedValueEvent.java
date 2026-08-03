package com.agui.community.core.event;

import java.util.Objects;

/**
 * Carries an encrypted chain-of-thought blob for a message or tool call whose
 * reasoning is not exposed in plain text.
 *
 * @param subtype        the entity type, either {@code "message"} or
 *                       {@code "tool-call"} (required)
 * @param entityId       the id of the message or tool call (required)
 * @param encryptedValue the encrypted chain-of-thought blob (required)
 * @param timestamp      the event creation time in epoch milliseconds, or
 *                       {@code null} (optional)
 * @param rawEvent       the original event this was transformed from, or
 *                       {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningEncryptedValueEvent(String subtype, String entityId, String encryptedValue,
                                           Long timestamp, Object rawEvent) implements Event {

    public ReasoningEncryptedValueEvent {
        Objects.requireNonNull(subtype, "subtype must not be null");
        Objects.requireNonNull(entityId, "entityId must not be null");
        Objects.requireNonNull(encryptedValue, "encryptedValue must not be null");
    }

    /**
     * Creates a reasoning-encrypted-value event with the required fields.
     *
     * @param subtype        the entity type ({@code "message"} or
     *                       {@code "tool-call"})
     * @param entityId       the id of the message or tool call
     * @param encryptedValue the encrypted chain-of-thought blob
     */
    public ReasoningEncryptedValueEvent(String subtype, String entityId, String encryptedValue) {
        this(subtype, entityId, encryptedValue, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_ENCRYPTED_VALUE;
    }
}
