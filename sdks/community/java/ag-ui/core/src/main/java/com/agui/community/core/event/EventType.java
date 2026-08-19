package com.agui.community.core.event;

/**
 * The discriminator identifying the concrete type of an {@link Event}. The
 * enum constant name matches the wire value used in the AG-UI protocol.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public enum EventType {

    // Lifecycle
    RUN_STARTED,
    RUN_FINISHED,
    RUN_ERROR,
    STEP_STARTED,
    STEP_FINISHED,

    // Text messages
    TEXT_MESSAGE_START,
    TEXT_MESSAGE_CONTENT,
    TEXT_MESSAGE_END,
    TEXT_MESSAGE_CHUNK,

    // Tool calls
    TOOL_CALL_START,
    TOOL_CALL_ARGS,
    TOOL_CALL_END,
    TOOL_CALL_CHUNK,
    TOOL_CALL_RESULT,

    // Reasoning
    REASONING_START,
    REASONING_END,
    REASONING_MESSAGE_START,
    REASONING_MESSAGE_CONTENT,
    REASONING_MESSAGE_END,
    REASONING_MESSAGE_CHUNK,
    REASONING_ENCRYPTED_VALUE,

    // State management
    STATE_SNAPSHOT,
    STATE_DELTA,
    MESSAGES_SNAPSHOT,

    // Activity
    ACTIVITY_SNAPSHOT,
    ACTIVITY_DELTA,

    // Special
    RAW,
    CUSTOM,
    META_EVENT;

    /**
     * @return the wire value of this event type as used in the AG-UI protocol
     */
    public String value() {
        return name();
    }

    /**
     * Resolves an {@link EventType} from its wire value.
     *
     * @param value the protocol value (e.g. {@code "RUN_STARTED"})
     * @return the matching event type
     * @throws IllegalArgumentException if no event type matches the given value
     */
    public static EventType fromValue(String value) {
        return valueOf(value);
    }
}
