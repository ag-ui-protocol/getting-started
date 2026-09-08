using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

[JsonConverter(typeof(RunFinishedOutcomeJsonConverter))]
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public abstract class RunFinishedOutcome
{
    internal RunFinishedOutcome() { }

    [JsonPropertyName("type")]
    public abstract string Type { get; }
}
