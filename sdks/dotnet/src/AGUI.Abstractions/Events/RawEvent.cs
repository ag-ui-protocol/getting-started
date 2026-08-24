using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Raw event for passing through unprocessed external data.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class RawEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.Raw;

    /// <summary>
    /// The raw event payload as a raw JSON element.
    /// </summary>
    [JsonPropertyName("event")]
    public JsonElement Event { get; set; }

    /// <summary>
    /// Optional source identifier for the raw data.
    /// </summary>
    [JsonPropertyName("source")]
    public string? Source { get; set; }
}
