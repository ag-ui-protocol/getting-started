using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Custom event for application-specific data.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class CustomEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.Custom;

    /// <summary>
    /// The custom event name/subtype.
    /// </summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// The custom event payload as a raw JSON element.
    /// </summary>
    [JsonPropertyName("value")]
    public JsonElement? Value { get; set; }

    /// <summary>
    /// Gets or sets the subagent that produced this event, absent when the parent agent
    /// produced it directly.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
