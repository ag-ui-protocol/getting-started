using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

/// <summary>
/// Used for application-specific custom events.
/// </summary>
public sealed record CustomEvent : BaseEvent
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("value")]
    public required object Value { get; init; }
}