using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Compact tool call chunk event with optional fields, standing in for a tool
/// call's start, args and end sequence.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ToolCallChunkEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ToolCallChunk;

    /// <summary>
    /// Gets or sets the optional tool call identifier. Absent continues the
    /// call already open.
    /// </summary>
    [JsonPropertyName("toolCallId")]
    public string? ToolCallId { get; set; }

    /// <summary>
    /// Gets or sets the optional tool name, on the chunk that opens the call.
    /// </summary>
    [JsonPropertyName("toolCallName")]
    public string? ToolCallName { get; set; }

    /// <summary>
    /// Gets or sets the optional parent message identifier.
    /// </summary>
    [JsonPropertyName("parentMessageId")]
    public string? ParentMessageId { get; set; }

    /// <summary>
    /// Gets or sets the optional arguments delta.
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
