using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event carrying an encrypted reasoning value.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ReasoningEncryptedValueEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ReasoningEncryptedValue;

    /// <summary>
    /// Gets or sets the subtype (e.g. "tool-call" or "message").
    /// </summary>
    [JsonPropertyName("subtype")]
    public string Subtype { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the entity identifier.
    /// </summary>
    [JsonPropertyName("entityId")]
    public string EntityId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the encrypted value.
    /// </summary>
    [JsonPropertyName("encryptedValue")]
    public string EncryptedValue { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the subagent that produced this event, absent when the parent agent
    /// produced it directly.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }
}
