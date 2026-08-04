using System;
using System.Collections.Generic;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

/// <summary>
/// Options for configuring how <see cref="ChatResponseUpdate"/> streams are converted to AG-UI event streams.
/// </summary>
/// <remarks>
/// Mapping configuration is method-based and fluent — the <c>Map*</c> helpers register mappings for
/// tool calls, tool results, custom interrupts, and otherwise-unmapped <see cref="AIContent"/>
/// instances, and each returns the same instance so calls can be chained. Plain toggles such as
/// <see cref="IncludeRawEvents"/> are init-only properties, so combine the two with an object
/// initializer: <c>new AGUIStreamOptions { IncludeRawEvents = false }.MapResultAsStateSnapshot("x")</c>.
/// </remarks>
public sealed class AGUIStreamOptions
{
    private readonly Dictionary<string, Func<FunctionResultContent, IEnumerable<BaseEvent>>> _resultMappings = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Func<FunctionCallContent, IEnumerable<BaseEvent>>> _callMappings = new(StringComparer.Ordinal);
    private List<Func<AIContent, AGUIInterrupt?>>? _interruptMappers;
    private List<Func<AIContent, IEnumerable<BaseEvent>?>>? _contentMappers;

    /// <summary>
    /// Gets a value indicating whether the originating <see cref="ChatResponseUpdate"/> is serialized
    /// and attached as <see cref="BaseEvent.RawEvent"/> to the events derived from it. Defaults to
    /// <see langword="true"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The attachment applies to the <c>TEXT_MESSAGE_*</c>, <c>TOOL_CALL_*</c>, and
    /// <c>REASONING_ENCRYPTED_VALUE</c> events produced from an update; events the SDK synthesizes on
    /// its own (<c>RUN_STARTED</c>, <c>RUN_FINISHED</c>) and events supplied by a caller — whether via
    /// <see cref="ChatResponseUpdate.RawRepresentation"/> or a registered mapping — are never touched.
    /// </para>
    /// <para>
    /// Setting this to <see langword="false"/> skips the serialization entirely, which removes both the
    /// wire cost (the payload is typically several times the size of a small text delta) and the
    /// per-update serialization work. Turn it off unless a client actually reads <c>rawEvent</c>.
    /// </para>
    /// </remarks>
    public bool IncludeRawEvents { get; init; } = true;

    /// <summary>
    /// Registers a fallback that maps an <see cref="AIContent"/> to an <see cref="AGUIInterrupt"/>.
    /// When the registered mapper returns a non-null value, the hosting layer emits a
    /// <see cref="RunFinishedEvent"/> with a <see cref="RunFinishedInterruptOutcome"/> carrying the interrupt
    /// and the run terminates. This is invoked for content types not handled by the built-in mappings
    /// (text, tool calls, tool results, and tool approval requests).
    /// </summary>
    /// <remarks>
    /// Multiple mappers may be registered. They are tried in registration order and the first non-null
    /// result wins. Return <see langword="null"/> from a mapper to skip and try the next one (or to fall
    /// through to <see cref="MapContent"/>).
    /// </remarks>
    /// <param name="mapper">A callback that receives an <see cref="AIContent"/> and returns an <see cref="AGUIInterrupt"/> or <see langword="null"/>.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIStreamOptions MapInterrupt(Func<AIContent, AGUIInterrupt?> mapper)
    {
        ArgumentNullException.ThrowIfNull(mapper);
        _interruptMappers ??= [];
        _interruptMappers.Add(mapper);
        return this;
    }

    /// <summary>
    /// Registers a fallback that maps an <see cref="AIContent"/> to a sequence of AG-UI <see cref="BaseEvent"/>
    /// instances. Invoked for content types that are not handled by the built-in mappings and that none of the
    /// registered <see cref="MapInterrupt"/> mappers claimed. Frameworks use this to surface their own content
    /// types (e.g., workflow step events) as AG-UI events.
    /// </summary>
    /// <remarks>
    /// Multiple mappers may be registered. They are tried in registration order; the first non-null result
    /// is emitted and the remaining mappers are not consulted. Return <see langword="null"/> from a mapper
    /// to skip and try the next one (or to drop the content entirely if no mapper handles it).
    /// </remarks>
    /// <param name="mapper">A callback that receives an <see cref="AIContent"/> and returns the AG-UI events to emit, or <see langword="null"/> to skip.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIStreamOptions MapContent(Func<AIContent, IEnumerable<BaseEvent>?> mapper)
    {
        ArgumentNullException.ThrowIfNull(mapper);
        _contentMappers ??= [];
        _contentMappers.Add(mapper);
        return this;
    }

    /// <summary>
    /// Registers a mapping that converts the result of a tool call to AG-UI events.
    /// When a <see cref="FunctionResultContent"/> with a matching tool name is encountered,
    /// the <paramref name="mapper"/> callback is invoked and the returned events are emitted
    /// after the normal tool result event.
    /// </summary>
    /// <param name="toolName">The name of the tool to map.</param>
    /// <param name="mapper">A callback that receives the <see cref="FunctionResultContent"/> and returns the events to emit.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIStreamOptions MapResult(string toolName, Func<FunctionResultContent, IEnumerable<BaseEvent>> mapper)
    {
        ArgumentNullException.ThrowIfNull(toolName);
        ArgumentNullException.ThrowIfNull(mapper);
        _resultMappings[toolName] = mapper;
        return this;
    }

    /// <summary>
    /// Registers a convenience mapping that emits a <see cref="StateSnapshotEvent"/> from the tool result.
    /// The <see cref="FunctionResultContent.Result"/> is expected to be a <see cref="JsonElement"/>
    /// and is used as the <see cref="StateSnapshotEvent.Snapshot"/>.
    /// </summary>
    /// <param name="toolName">The name of the tool to map.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIStreamOptions MapResultAsStateSnapshot(string toolName) =>
        MapResult(toolName, frc => [new StateSnapshotEvent { Snapshot = CastToJsonElement(frc.Result) }]);

    /// <summary>
    /// Registers a convenience mapping that emits a <see cref="StateDeltaEvent"/> from the tool result.
    /// The <see cref="FunctionResultContent.Result"/> is expected to be a <see cref="JsonElement"/>
    /// and is used as the <see cref="StateDeltaEvent.Delta"/>.
    /// </summary>
    /// <param name="toolName">The name of the tool to map.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIStreamOptions MapResultAsStateDelta(string toolName) =>
        MapResult(toolName, frc => [new StateDeltaEvent { Delta = CastToJsonElement(frc.Result) }]);

    /// <summary>
    /// Registers a mapping that converts a tool call's arguments to AG-UI events.
    /// When a <see cref="FunctionCallContent"/> with a matching tool name is encountered,
    /// the <paramref name="mapper"/> callback is invoked and the returned events are emitted
    /// after the normal tool call events.
    /// </summary>
    /// <param name="toolName">The name of the tool to map.</param>
    /// <param name="mapper">A callback that receives the <see cref="FunctionCallContent"/> and returns the events to emit.</param>
    /// <returns>This instance for fluent chaining.</returns>
    public AGUIStreamOptions MapCall(string toolName, Func<FunctionCallContent, IEnumerable<BaseEvent>> mapper)
    {
        ArgumentNullException.ThrowIfNull(toolName);
        ArgumentNullException.ThrowIfNull(mapper);
        _callMappings[toolName] = mapper;
        return this;
    }

    internal AGUIInterrupt? InvokeInterruptMappers(AIContent content)
    {
        if (_interruptMappers is null)
        {
            return null;
        }

        foreach (var mapper in _interruptMappers)
        {
            if (mapper(content) is { } interrupt)
            {
                return interrupt;
            }
        }

        return null;
    }

    internal IEnumerable<BaseEvent>? InvokeContentMappers(AIContent content)
    {
        if (_contentMappers is null)
        {
            return null;
        }

        foreach (var mapper in _contentMappers)
        {
            var events = mapper(content);
            if (events is not null)
            {
                return events;
            }
        }

        return null;
    }

    internal bool TryGetResultMapping(string toolName, out Func<FunctionResultContent, IEnumerable<BaseEvent>> mapper) =>
        _resultMappings.TryGetValue(toolName, out mapper!);

    internal bool TryGetCallMapping(string toolName, out Func<FunctionCallContent, IEnumerable<BaseEvent>> mapper) =>
        _callMappings.TryGetValue(toolName, out mapper!);

    private static JsonElement CastToJsonElement(object? result) =>
        result is JsonElement jsonElement
            ? jsonElement
            : throw new InvalidOperationException(
                $"Expected tool result to be a JsonElement, but got {result?.GetType().Name ?? "null"}. " +
                "Use the MapResult overload with a custom mapper for non-JsonElement results.");
}
