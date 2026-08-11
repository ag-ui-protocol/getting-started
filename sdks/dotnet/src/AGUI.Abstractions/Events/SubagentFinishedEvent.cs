using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event signaling that a subagent completed its work successfully. Terminal for the
/// subagent it names: it may not be finished again, nor restarted within the run.
/// Events attributed to it afterwards remain valid — a continuation carries the tag of
/// the subagent it belongs to even after that subagent has finished.
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
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Result { get; set; }
}
