using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record ToolCallStartEvent : BaseEvent
{
    [JsonPropertyName("toolCallId")]
    public required string ToolCallId { get; init; }

    [JsonPropertyName("toolCallName")]
    public required string ToolCallName { get; init; }

    [JsonPropertyName("parentMessageId")]
    public string? ParentMessageId { get; init; }
}