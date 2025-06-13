using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record RunErrorEvent : BaseEvent
{
    [JsonPropertyName("message")]
    public required string Message { get; init; }

    [JsonPropertyName("code")]
    public string? Code { get; init; }
}