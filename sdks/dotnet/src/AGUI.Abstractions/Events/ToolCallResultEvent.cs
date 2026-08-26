using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event returning a tool call result to the agent.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ToolCallResultEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ToolCallResult;

    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = string.Empty;

    [JsonPropertyName("toolCallId")]
    public string ToolCallId { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string? Role { get; set; }

    /// <summary>
    /// Gets or sets the failure detail for this tool call. The event-side twin of
    /// <see cref="AGUIToolMessage.Error"/>. Schema only: no producer populates it yet, so an
    /// absent error means the producer said nothing about failure, not that the call succeeded.
    /// The client's event-to-<c>ChatResponseUpdate</c> conversion does not read it either, so a
    /// consumer wanting the failure from the live stream has to read it off the event itself.
    /// An explicit JSON null deserializes to <c>null</c>, as for every optional property here.
    /// </summary>
    [JsonPropertyName("error")]
    public string? Error { get; set; }

    /// <summary>
    /// Gets or sets the subagent that produced this event, absent when the parent agent
    /// produced it directly.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
