package com.agui.community.core.event;

/**
 * A single event emitted by an AG-UI agent.
 *
 * <p>This is a sealed type: every event carries the {@code BaseEvent} fields
 * ({@link #type()}, {@link #timestamp()} and {@link #rawEvent()}) and is one of
 * the concrete event types permitted below. Use a {@code switch} on the
 * implementation type to handle each variant exhaustively.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public sealed interface Event permits
        RunStartedEvent, RunFinishedEvent, RunErrorEvent, StepStartedEvent, StepFinishedEvent,
        TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent, TextMessageChunkEvent,
        ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallChunkEvent, ToolCallResultEvent,
        ReasoningStartEvent, ReasoningEndEvent, ReasoningMessageStartEvent, ReasoningMessageContentEvent,
        ReasoningMessageEndEvent, ReasoningMessageChunkEvent, ReasoningEncryptedValueEvent,
        StateSnapshotEvent, StateDeltaEvent, MessagesSnapshotEvent,
        ActivitySnapshotEvent, ActivityDeltaEvent,
        RawEvent, CustomEvent, MetaEvent {

    /**
     * @return the discriminator identifying this event's concrete type
     */
    EventType type();

    /**
     * @return the time the event was created as epoch milliseconds, or
     *         {@code null} if not provided (optional)
     */
    Long timestamp();

    /**
     * @return the original event data this event was transformed from, or
     *         {@code null} if not provided (optional)
     */
    Object rawEvent();
}
