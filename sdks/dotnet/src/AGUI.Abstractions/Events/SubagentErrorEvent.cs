using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event signaling that a subagent failed. Terminal for the subagent it names, and the
/// counterpart to <see cref="SubagentFinishedEvent"/> — a subagent ends with exactly one
/// of the two, never both.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class SubagentErrorEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.SubagentError;

    /// <summary>
    /// Gets or sets the identifier of the subagent that failed.
    /// </summary>
    [JsonPropertyName("subagentId")]
    public string? SubagentId { get; set; }

    /// <summary>
    /// Gets or sets the error message.
    /// </summary>
    [JsonPropertyName("message")]
    public string? Message { get; set; }

    /// <summary>
    /// Gets or sets an optional machine-readable error code.
    /// </summary>
    [JsonPropertyName("code")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Code { get; set; }
}
