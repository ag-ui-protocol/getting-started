using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class RunFinishedEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.RunFinished;

    [JsonPropertyName("threadId")]
    public string ThreadId { get; set; } = string.Empty;

    [JsonPropertyName("runId")]
    public string RunId { get; set; } = string.Empty;

    [JsonPropertyName("result")]
    public JsonElement? Result { get; set; }

    [JsonPropertyName("outcome")]
    public RunFinishedOutcome? Outcome { get; set; }

    // Optional per-(provider, model) token usage for the completed run. A list so
    // runs that invoke multiple models keep them separate; consumers that only
    // need totals can sum across entries. Null (not an empty list) when no usage
    // was reported, so the field is omitted on the wire and legacy events
    // round-trip unchanged.
    [JsonPropertyName("usage")]
    public IList<TokenUsage>? Usage { get; set; }
}
