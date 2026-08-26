using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event providing a full snapshot of an activity's content.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ActivitySnapshotEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ActivitySnapshot;

    /// <summary>
    /// Unique identifier for the activity message.
    /// </summary>
    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = string.Empty;

    /// <summary>
    /// Discriminator for the type of activity (e.g., "PLAN", "SEARCH").
    /// </summary>
    [JsonPropertyName("activityType")]
    public string ActivityType { get; set; } = string.Empty;

    /// <summary>
    /// The activity content as a raw JSON element.
    /// </summary>
    [JsonPropertyName("content")]
    public JsonElement Content { get; set; }

    /// <summary>
    /// Whether to replace the existing activity content or merge. Defaults to <see langword="true"/>.
    /// </summary>
    [JsonPropertyName("replace")]
    public bool? Replace { get; set; }

    /// <summary>
    /// Gets or sets the subagent that produced this event, absent when the parent agent
    /// produced it directly.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
