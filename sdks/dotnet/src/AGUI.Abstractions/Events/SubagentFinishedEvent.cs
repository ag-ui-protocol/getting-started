using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event closing a subagent's stream segment for this run. Terminal for the
/// subagent it names: it may not be finished again, nor restarted within the run.
/// Events attributed to it afterwards remain valid — a continuation carries the tag of
/// the subagent it belongs to even after that subagent has finished.
/// <see cref="Outcome"/> distinguishes completed work ("success", also the meaning
/// of an omitted outcome) from a workflow paused awaiting outside input
/// ("suspended") — on resume the same subagentRunId is re-announced as a
/// continuation of the suspended invocation.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class SubagentFinishedEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.SubagentFinished;

    /// <summary>
    /// Gets or sets the identifier of the subagent this event closes.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }

    /// <summary>
    /// Gets or sets the subagent's completion payload, mirroring
    /// <see cref="RunFinishedEvent.Result"/>.
    /// </summary>
    [JsonPropertyName("result")]
    public JsonElement? Result { get; set; }

    /// <summary>
    /// Gets or sets the typed outcome, mirroring <see cref="RunFinishedEvent.Outcome"/>.
    /// Null means legacy success.
    /// </summary>
    [JsonPropertyName("outcome")]
    public SubagentFinishedOutcome? Outcome { get; set; }
}
