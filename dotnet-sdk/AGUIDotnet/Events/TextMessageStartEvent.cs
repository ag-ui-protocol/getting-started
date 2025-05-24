using System.Text.Json.Serialization;
using AGUIDotnet.Types;

namespace AGUIDotnet.Events;

public sealed record TextMessageStartEvent : BaseEvent
{
    [JsonPropertyName("messageId")]
    public required string MessageId { get; init; }

    [JsonPropertyName("role")]
#pragma warning disable CA1822 // Mark members as static
    public string Role => MessageRoles.Assistant;
#pragma warning restore CA1822 // Mark members as static
}
