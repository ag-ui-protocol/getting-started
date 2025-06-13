using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record TextMessageContentEvent : BaseEvent
{
    [JsonPropertyName("messageId")]
    public required string MessageId { get; init; }

    /// <summary>
    /// The chunk of text content to append to the message.
    /// </summary>
    [JsonPropertyName("delta")]
    public required string Delta { get; init; }
}
