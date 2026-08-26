using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Compact reasoning message chunk event with optional fields.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ReasoningMessageChunkEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ReasoningMessageChunk;

    /// <summary>
    /// Gets or sets the optional message identifier.
    /// </summary>
    [JsonPropertyName("messageId")]
    public string? MessageId { get; set; }

    /// <summary>
    /// Gets or sets the optional content delta.
    /// </summary>
    [JsonPropertyName("delta")]
    public string? Delta { get; set; }

    /// <summary>
    /// Gets or sets the subagent that produced this event, absent when the parent agent
    /// produced it directly.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
