using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUISystemMessage : AGUIMessage
{
    public override string Role => AGUIRoles.System;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("encryptedValue")]
    public string? EncryptedValue { get; set; }
}
