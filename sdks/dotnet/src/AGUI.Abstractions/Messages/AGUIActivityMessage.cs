using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Represents an activity message with structured content.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIActivityMessage : AGUIMessage
{
    public override string Role => AGUIRoles.Activity;

    /// <summary>
    /// Gets or sets the discriminator for the type of activity.
    /// </summary>
    [JsonPropertyName("activityType")]
    public string ActivityType { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the structured activity content as a JSON object.
    /// </summary>
    [JsonPropertyName("content")]
    public JsonElement Content { get; set; }
}
