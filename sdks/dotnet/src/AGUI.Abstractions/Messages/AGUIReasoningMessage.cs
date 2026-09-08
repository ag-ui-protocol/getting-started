using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIReasoningMessage : AGUIMessage
{
    public override string Role => AGUIRoles.Reasoning;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("encryptedValue")]
    public string? EncryptedValue { get; set; }
}
