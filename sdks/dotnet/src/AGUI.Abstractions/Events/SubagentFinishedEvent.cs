using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event signaling that a subagent completed its work successfully. Terminal for the
/// subagent it names: no further event may be attributed to that identifier.
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
    [JsonPropertyName("subagentId")]
    public string? SubagentId { get; set; }

    /// <summary>
    /// Gets or sets the subagent's completion payload, mirroring
    /// <see cref="RunFinishedEvent.Result"/>.
    /// </summary>
    [JsonPropertyName("result")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Result { get; set; }
}
