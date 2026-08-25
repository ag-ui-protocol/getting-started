using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Represents a context entry providing additional information to the agent.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIContext
{
    /// <summary>
    /// Gets or sets the description of the context entry.
    /// </summary>
    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the value of the context entry.
    /// </summary>
    [JsonPropertyName("value")]
    public string Value { get; set; } = string.Empty;
}
