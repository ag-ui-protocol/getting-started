using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

public sealed class BaseEventJsonConverter : JsonConverter<BaseEvent>
{
    private const string TypeDiscriminatorPropertyName = "type";

    public override bool CanConvert(Type typeToConvert) =>
        typeof(BaseEvent).IsAssignableFrom(typeToConvert);

    public override BaseEvent Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var jsonElementTypeInfo = options.GetTypeInfo(typeof(JsonElement));
        JsonElement jsonElement = (JsonElement)JsonSerializer.Deserialize(ref reader, jsonElementTypeInfo)!;

        if (!jsonElement.TryGetProperty(TypeDiscriminatorPropertyName, out JsonElement discriminatorElement))
        {
            throw new JsonException("Missing required property 'type' for BaseEvent deserialization");
        }

        // A required discriminator that is not a string is malformed input, not an
        // event from the future: it must not reach the unknown-type path, which
        // stream readers are allowed to skip.
        if (discriminatorElement.ValueKind != JsonValueKind.String)
        {
            throw new JsonException(
                $"Property 'type' for BaseEvent deserialization must be a string, not {discriminatorElement.ValueKind}");
        }

        string? discriminator = discriminatorElement.GetString();

        BaseEvent? result = discriminator switch
        {
            AGUIEventTypes.RunStarted => jsonElement.Deserialize(options.GetTypeInfo(typeof(RunStartedEvent))) as RunStartedEvent,
            AGUIEventTypes.RunFinished => jsonElement.Deserialize(options.GetTypeInfo(typeof(RunFinishedEvent))) as RunFinishedEvent,
            AGUIEventTypes.RunError => jsonElement.Deserialize(options.GetTypeInfo(typeof(RunErrorEvent))) as RunErrorEvent,
            AGUIEventTypes.StepStarted => jsonElement.Deserialize(options.GetTypeInfo(typeof(StepStartedEvent))) as StepStartedEvent,
            AGUIEventTypes.StepFinished => jsonElement.Deserialize(options.GetTypeInfo(typeof(StepFinishedEvent))) as StepFinishedEvent,
            AGUIEventTypes.TextMessageStart => jsonElement.Deserialize(options.GetTypeInfo(typeof(TextMessageStartEvent))) as TextMessageStartEvent,
            AGUIEventTypes.TextMessageContent => jsonElement.Deserialize(options.GetTypeInfo(typeof(TextMessageContentEvent))) as TextMessageContentEvent,
            AGUIEventTypes.TextMessageEnd => jsonElement.Deserialize(options.GetTypeInfo(typeof(TextMessageEndEvent))) as TextMessageEndEvent,
            AGUIEventTypes.TextMessageChunk => jsonElement.Deserialize(options.GetTypeInfo(typeof(TextMessageChunkEvent))) as TextMessageChunkEvent,
            AGUIEventTypes.ToolCallStart => jsonElement.Deserialize(options.GetTypeInfo(typeof(ToolCallStartEvent))) as ToolCallStartEvent,
            AGUIEventTypes.ToolCallArgs => jsonElement.Deserialize(options.GetTypeInfo(typeof(ToolCallArgsEvent))) as ToolCallArgsEvent,
            AGUIEventTypes.ToolCallEnd => jsonElement.Deserialize(options.GetTypeInfo(typeof(ToolCallEndEvent))) as ToolCallEndEvent,
            AGUIEventTypes.ToolCallChunk => jsonElement.Deserialize(options.GetTypeInfo(typeof(ToolCallChunkEvent))) as ToolCallChunkEvent,
            AGUIEventTypes.ToolCallResult => jsonElement.Deserialize(options.GetTypeInfo(typeof(ToolCallResultEvent))) as ToolCallResultEvent,
            AGUIEventTypes.StateSnapshot => jsonElement.Deserialize(options.GetTypeInfo(typeof(StateSnapshotEvent))) as StateSnapshotEvent,
            AGUIEventTypes.StateDelta => jsonElement.Deserialize(options.GetTypeInfo(typeof(StateDeltaEvent))) as StateDeltaEvent,
            AGUIEventTypes.ReasoningStart => jsonElement.Deserialize(options.GetTypeInfo(typeof(ReasoningStartEvent))) as ReasoningStartEvent,
            AGUIEventTypes.ReasoningMessageStart => jsonElement.Deserialize(options.GetTypeInfo(typeof(ReasoningMessageStartEvent))) as ReasoningMessageStartEvent,
            AGUIEventTypes.ReasoningMessageContent => jsonElement.Deserialize(options.GetTypeInfo(typeof(ReasoningMessageContentEvent))) as ReasoningMessageContentEvent,
            AGUIEventTypes.ReasoningMessageEnd => jsonElement.Deserialize(options.GetTypeInfo(typeof(ReasoningMessageEndEvent))) as ReasoningMessageEndEvent,
            AGUIEventTypes.ReasoningMessageChunk => jsonElement.Deserialize(options.GetTypeInfo(typeof(ReasoningMessageChunkEvent))) as ReasoningMessageChunkEvent,
            AGUIEventTypes.ReasoningEnd => jsonElement.Deserialize(options.GetTypeInfo(typeof(ReasoningEndEvent))) as ReasoningEndEvent,
            AGUIEventTypes.ReasoningEncryptedValue => jsonElement.Deserialize(options.GetTypeInfo(typeof(ReasoningEncryptedValueEvent))) as ReasoningEncryptedValueEvent,
            AGUIEventTypes.ActivitySnapshot => jsonElement.Deserialize(options.GetTypeInfo(typeof(ActivitySnapshotEvent))) as ActivitySnapshotEvent,
            AGUIEventTypes.ActivityDelta => jsonElement.Deserialize(options.GetTypeInfo(typeof(ActivityDeltaEvent))) as ActivityDeltaEvent,
            AGUIEventTypes.Custom => jsonElement.Deserialize(options.GetTypeInfo(typeof(CustomEvent))) as CustomEvent,
            AGUIEventTypes.Raw => jsonElement.Deserialize(options.GetTypeInfo(typeof(RawEvent))) as RawEvent,
            AGUIEventTypes.MessagesSnapshot => jsonElement.Deserialize(options.GetTypeInfo(typeof(MessagesSnapshotEvent))) as MessagesSnapshotEvent,
            AGUIEventTypes.SubagentStarted => jsonElement.Deserialize(options.GetTypeInfo(typeof(SubagentStartedEvent))) as SubagentStartedEvent,
            AGUIEventTypes.SubagentFinished => jsonElement.Deserialize(options.GetTypeInfo(typeof(SubagentFinishedEvent))) as SubagentFinishedEvent,
            AGUIEventTypes.SubagentError => jsonElement.Deserialize(options.GetTypeInfo(typeof(SubagentErrorEvent))) as SubagentErrorEvent,
            // A type this build has no model for: the stream reader skips it, a
            // caller decoding a single event sees it.
            _ => throw new AGUIUnknownEventTypeException(
                $"Unknown BaseEvent type discriminator: '{discriminator}'", discriminator)
        };

        if (result == null)
        {
            throw new JsonException($"Failed to deserialize BaseEvent with type discriminator: '{discriminator}'");
        }

        return result;
    }

    public override void Write(Utf8JsonWriter writer, BaseEvent value, JsonSerializerOptions options)
    {
        switch (value)
        {
            case RunStartedEvent runStarted:
                JsonSerializer.Serialize(writer, runStarted, options.GetTypeInfo(typeof(RunStartedEvent)));
                break;
            case RunFinishedEvent runFinished:
                JsonSerializer.Serialize(writer, runFinished, options.GetTypeInfo(typeof(RunFinishedEvent)));
                break;
            case RunErrorEvent runError:
                JsonSerializer.Serialize(writer, runError, options.GetTypeInfo(typeof(RunErrorEvent)));
                break;
            case StepStartedEvent stepStarted:
                JsonSerializer.Serialize(writer, stepStarted, options.GetTypeInfo(typeof(StepStartedEvent)));
                break;
            case StepFinishedEvent stepFinished:
                JsonSerializer.Serialize(writer, stepFinished, options.GetTypeInfo(typeof(StepFinishedEvent)));
                break;
            case TextMessageStartEvent textStart:
                JsonSerializer.Serialize(writer, textStart, options.GetTypeInfo(typeof(TextMessageStartEvent)));
                break;
            case TextMessageContentEvent textContent:
                JsonSerializer.Serialize(writer, textContent, options.GetTypeInfo(typeof(TextMessageContentEvent)));
                break;
            case TextMessageEndEvent textEnd:
                JsonSerializer.Serialize(writer, textEnd, options.GetTypeInfo(typeof(TextMessageEndEvent)));
                break;
            case ToolCallStartEvent toolCallStart:
                JsonSerializer.Serialize(writer, toolCallStart, options.GetTypeInfo(typeof(ToolCallStartEvent)));
                break;
            case ToolCallArgsEvent toolCallArgs:
                JsonSerializer.Serialize(writer, toolCallArgs, options.GetTypeInfo(typeof(ToolCallArgsEvent)));
                break;
            case ToolCallEndEvent toolCallEnd:
                JsonSerializer.Serialize(writer, toolCallEnd, options.GetTypeInfo(typeof(ToolCallEndEvent)));
                break;
            case ToolCallResultEvent toolCallResult:
                JsonSerializer.Serialize(writer, toolCallResult, options.GetTypeInfo(typeof(ToolCallResultEvent)));
                break;
            case StateSnapshotEvent stateSnapshot:
                JsonSerializer.Serialize(writer, stateSnapshot, options.GetTypeInfo(typeof(StateSnapshotEvent)));
                break;
            case StateDeltaEvent stateDelta:
                JsonSerializer.Serialize(writer, stateDelta, options.GetTypeInfo(typeof(StateDeltaEvent)));
                break;
            case ReasoningStartEvent reasoningStart:
                JsonSerializer.Serialize(writer, reasoningStart, options.GetTypeInfo(typeof(ReasoningStartEvent)));
                break;
            case ReasoningMessageStartEvent reasoningMessageStart:
                JsonSerializer.Serialize(writer, reasoningMessageStart, options.GetTypeInfo(typeof(ReasoningMessageStartEvent)));
                break;
            case ReasoningMessageContentEvent reasoningMessageContent:
                JsonSerializer.Serialize(writer, reasoningMessageContent, options.GetTypeInfo(typeof(ReasoningMessageContentEvent)));
                break;
            case ReasoningMessageEndEvent reasoningMessageEnd:
                JsonSerializer.Serialize(writer, reasoningMessageEnd, options.GetTypeInfo(typeof(ReasoningMessageEndEvent)));
                break;
            case ReasoningMessageChunkEvent reasoningMessageChunk:
                JsonSerializer.Serialize(writer, reasoningMessageChunk, options.GetTypeInfo(typeof(ReasoningMessageChunkEvent)));
                break;
            case TextMessageChunkEvent textMessageChunk:
                JsonSerializer.Serialize(writer, textMessageChunk, options.GetTypeInfo(typeof(TextMessageChunkEvent)));
                break;
            case ToolCallChunkEvent toolCallChunk:
                JsonSerializer.Serialize(writer, toolCallChunk, options.GetTypeInfo(typeof(ToolCallChunkEvent)));
                break;
            case ReasoningEndEvent reasoningEnd:
                JsonSerializer.Serialize(writer, reasoningEnd, options.GetTypeInfo(typeof(ReasoningEndEvent)));
                break;
            case ReasoningEncryptedValueEvent reasoningEncryptedValue:
                JsonSerializer.Serialize(writer, reasoningEncryptedValue, options.GetTypeInfo(typeof(ReasoningEncryptedValueEvent)));
                break;
            case ActivitySnapshotEvent activitySnapshot:
                JsonSerializer.Serialize(writer, activitySnapshot, options.GetTypeInfo(typeof(ActivitySnapshotEvent)));
                break;
            case ActivityDeltaEvent activityDelta:
                JsonSerializer.Serialize(writer, activityDelta, options.GetTypeInfo(typeof(ActivityDeltaEvent)));
                break;
            case CustomEvent customEvent:
                JsonSerializer.Serialize(writer, customEvent, options.GetTypeInfo(typeof(CustomEvent)));
                break;
            case RawEvent rawEvent:
                JsonSerializer.Serialize(writer, rawEvent, options.GetTypeInfo(typeof(RawEvent)));
                break;
            case MessagesSnapshotEvent messagesSnapshot:
                JsonSerializer.Serialize(writer, messagesSnapshot, options.GetTypeInfo(typeof(MessagesSnapshotEvent)));
                break;
            case SubagentStartedEvent subagentStarted:
                JsonSerializer.Serialize(writer, subagentStarted, options.GetTypeInfo(typeof(SubagentStartedEvent)));
                break;
            case SubagentFinishedEvent subagentFinished:
                JsonSerializer.Serialize(writer, subagentFinished, options.GetTypeInfo(typeof(SubagentFinishedEvent)));
                break;
            case SubagentErrorEvent subagentError:
                JsonSerializer.Serialize(writer, subagentError, options.GetTypeInfo(typeof(SubagentErrorEvent)));
                break;
            default:
                // A model this converter has no case for: as on the read side,
                // an event nothing recognises is named rather than guessed at.
                throw new AGUIUnknownEventTypeException(
                    $"Unknown event type: {value.GetType().Name}", value.Type);
        }
    }
}
