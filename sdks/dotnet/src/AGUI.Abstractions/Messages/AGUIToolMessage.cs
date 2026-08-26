using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIToolMessage : AGUIMessage
{
    public override string Role => AGUIRoles.Tool;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    // Required per spec: a tool result is always tied to the tool call it answers.
    [JsonPropertyName("toolCallId")]
    public string ToolCallId { get; set; } = string.Empty;

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("encryptedValue")]
    public string? EncryptedValue { get; set; }
}
