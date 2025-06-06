using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

/// <summary>
/// Used to pass through events from external systems.
/// </summary>
public sealed record RawEvent : BaseEvent
{
    [JsonPropertyName("event")]
    public required object Event { get; init; }

    [JsonPropertyName("source")]
    public string? Source { get; init; }
}
