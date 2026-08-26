using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Typed outcome for <see cref="SubagentFinishedEvent"/>, mirroring
/// <see cref="RunFinishedOutcome"/> one level down: a subagent's terminal closes
/// its stream segment for THIS run either because the work completed
/// ("success") or because the workflow is paused awaiting outside input
/// ("suspended"). An omitted outcome means legacy success.
/// </summary>
[JsonConverter(typeof(SubagentFinishedOutcomeJsonConverter))]
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public abstract class SubagentFinishedOutcome
{
    internal SubagentFinishedOutcome() { }

    [JsonPropertyName("type")]
    public abstract string Type { get; }
}
