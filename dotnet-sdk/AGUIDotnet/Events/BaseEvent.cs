using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(RunStartedEvent), EventTypes.RUN_STARTED)]
[JsonDerivedType(typeof(RunFinishedEvent), EventTypes.RUN_FINISHED)]
[JsonDerivedType(typeof(RunErrorEvent), EventTypes.RUN_ERROR)]
[JsonDerivedType(typeof(StepStartedEvent), EventTypes.STEP_STARTED)]
[JsonDerivedType(typeof(StepFinishedEvent), EventTypes.STEP_FINISHED)]
[JsonDerivedType(typeof(TextMessageStartEvent), EventTypes.TEXT_MESSAGE_START)]
[JsonDerivedType(typeof(TextMessageContentEvent), EventTypes.TEXT_MESSAGE_CONTENT)]
[JsonDerivedType(typeof(TextMessageEndEvent), EventTypes.TEXT_MESSAGE_END)]
[JsonDerivedType(typeof(ToolCallStartEvent), EventTypes.TOOL_CALL_START)]
[JsonDerivedType(typeof(ToolCallArgsEvent), EventTypes.TOOL_CALL_ARGS)]
[JsonDerivedType(typeof(ToolCallEndEvent), EventTypes.TOOL_CALL_END)]
[JsonDerivedType(typeof(StateSnapshotEvent), EventTypes.STATE_SNAPSHOT)]
[JsonDerivedType(typeof(StateDeltaEvent), EventTypes.STATE_DELTA)]
[JsonDerivedType(typeof(CustomEvent), EventTypes.CUSTOM)]
[JsonDerivedType(typeof(RawEvent), EventTypes.RAW)]
[JsonDerivedType(typeof(MessagesSnapshotEvent), EventTypes.MESSAGES_SNAPSHOT)]

public abstract record BaseEvent
{
    [JsonPropertyName("timestamp")]
    public long? Timestamp { get; init; }

    [JsonPropertyName("rawEvent")]
    public object? RawEvent { get; init; }
}
