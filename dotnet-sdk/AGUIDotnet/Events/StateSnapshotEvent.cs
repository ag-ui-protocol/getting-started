using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record StateSnapshotEvent : BaseEvent
{
    [JsonPropertyName("snapshot")]
    public required object Snapshot { get; init; }
}