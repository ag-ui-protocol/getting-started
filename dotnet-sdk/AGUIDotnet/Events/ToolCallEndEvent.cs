using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record ToolCallEndEvent : BaseEvent
{
    [JsonPropertyName("toolCallId")]
    public required string ToolCallId { get; init; }
}