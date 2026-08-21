using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event signaling the start of a tool call from the agent.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ToolCallStartEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ToolCallStart;

    [JsonPropertyName("parentMessageId")]
    public string? ParentMessageId { get; set; }

    [JsonPropertyName("toolCallId")]
    public string ToolCallId { get; set; } = string.Empty;

    [JsonPropertyName("toolCallName")]
    public string ToolCallName { get; set; } = string.Empty;
}
