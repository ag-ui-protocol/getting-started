using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event indicating a reasoning phase has started.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ReasoningStartEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ReasoningStart;

    /// <summary>
    /// Gets or sets the message identifier.
    /// </summary>
    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the subagent that produced this event, absent when the parent agent
    /// produced it directly.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
