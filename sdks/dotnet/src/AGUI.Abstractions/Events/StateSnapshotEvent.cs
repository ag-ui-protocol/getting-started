using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event providing a full state snapshot.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class StateSnapshotEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.StateSnapshot;

    /// <summary>
    /// The complete state object serialized as a JSON element.
    /// </summary>
    [JsonPropertyName("snapshot")]
    public JsonElement Snapshot { get; set; }

    /// <summary>
    /// Gets or sets the subagent that produced this event. State events are attributable,
    /// and attribution here is provenance rather than ownership: it records which subagent
    /// produced the update, while the state itself stays run-scoped and is applied
    /// run-scoped. There is no per-subagent state -- an attributed snapshot replaces the
    /// run's state exactly as an unattributed one does.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
