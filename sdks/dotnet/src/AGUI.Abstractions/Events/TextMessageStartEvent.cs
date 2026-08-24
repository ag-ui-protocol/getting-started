using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class TextMessageStartEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.TextMessageStart;

    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string? Name { get; set; }
}
