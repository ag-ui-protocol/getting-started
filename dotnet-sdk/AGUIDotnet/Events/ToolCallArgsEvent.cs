using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record ToolCallArgsEvent : BaseEvent
{
    [JsonPropertyName("toolCallId")]
    public required string ToolCallId { get; init; }

    /// <summary>
    /// The JSON-encoded next chunk of the tool call arguments.
    /// </summary>
    [JsonPropertyName("delta")]
    public required string Delta { get; init; }
}
