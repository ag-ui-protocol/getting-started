using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record StepFinishedEvent : BaseEvent
{
    [JsonPropertyName("stepName")]
    public required string StepName { get; init; }
}