using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record RunFinishedEvent : BaseEvent
{
    [JsonPropertyName("threadId")]
    public required string ThreadId { get; init; }

    [JsonPropertyName("runId")]
    public required string RunId { get; init; }
}