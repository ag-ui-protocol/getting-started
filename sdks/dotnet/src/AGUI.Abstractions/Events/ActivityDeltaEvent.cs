using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event providing incremental activity changes via JSON Patch (RFC 6902).
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ActivityDeltaEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ActivityDelta;

    /// <summary>
    /// Unique identifier for the activity message being updated.
    /// </summary>
    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = string.Empty;

    /// <summary>
    /// Discriminator for the type of activity (e.g., "PLAN", "SEARCH").
    /// </summary>
    [JsonPropertyName("activityType")]
    public string ActivityType { get; set; } = string.Empty;

    /// <summary>
    /// The JSON Patch operations as a raw JSON element.
    /// </summary>
    [JsonPropertyName("patch")]
    public JsonElement Patch { get; set; }

    /// <summary>
    /// Gets or sets the subagent that produced this event, absent when the parent agent
    /// produced it directly.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
