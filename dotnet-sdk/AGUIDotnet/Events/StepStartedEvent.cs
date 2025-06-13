using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record StepStartedEvent : BaseEvent
{
    [JsonPropertyName("stepName")]
    public required string StepName { get; init; }
}
