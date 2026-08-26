using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class RunErrorEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.RunError;

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("code")]
    public string? Code { get; set; }

    // Optional partial usage for a run that failed after one or more model calls
    // completed. Same numeric-only shape as RUN_FINISHED.
    [JsonPropertyName("usage")]
    public IList<TokenUsage>? Usage { get; set; }
}
