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
    /// Gets or sets the subagent that produced this event. Present so the type mirrors
    /// the protocol schema, which carries the field on every attributable event. A
    /// conforming producer never sets it here: only the parent owns state, and a consumer
    /// applies state without consulting attribution, so a subagent's partial state would
    /// land as if the parent had sent it.
    /// </summary>
    [JsonPropertyName("subagentId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SubagentId { get; set; }
}
