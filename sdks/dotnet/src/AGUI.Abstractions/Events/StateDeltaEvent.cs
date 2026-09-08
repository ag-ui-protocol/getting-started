using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event providing incremental state changes via JSON Patch (RFC 6902).
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class StateDeltaEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.StateDelta;

    /// <summary>
    /// The delta payload as a raw JSON element.
    /// </summary>
    [JsonPropertyName("delta")]
    public JsonElement Delta { get; set; }

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
