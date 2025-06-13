using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record TextMessageEndEvent : BaseEvent
{
    [JsonPropertyName("messageId")]
    public required string MessageId { get; init; }
}