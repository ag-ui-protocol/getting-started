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
    /// Gets or sets the failure detail for this tool call, the event-side twin of
    /// <see cref="AGUIToolMessage.Error"/>. A non-null value reports a failed call,
    /// <see cref="string.Empty"/> included: a producer that sends the empty string chose to
    /// send it, so test <c>Error is not null</c> rather than <c>string.IsNullOrEmpty(Error)</c>.
    /// A <see langword="null"/> value reports nothing about failure, which is not the same as
    /// the call having succeeded. An absent JSON key and an explicit JSON null both deserialize
    /// to <see langword="null"/>, as for every optional property here, so the contract is stated
    /// on the value rather than on presence; a non-string value is a deserialization error.
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
