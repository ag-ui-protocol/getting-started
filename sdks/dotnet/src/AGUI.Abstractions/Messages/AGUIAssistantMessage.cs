using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIAssistantMessage : AGUIMessage
{
    public override string Role => AGUIRoles.Assistant;

    // Optional per spec: assistant turns that carry only tool calls have no content.
    [JsonPropertyName("content")]
    public string? Content { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("encryptedValue")]
    public string? EncryptedValue { get; set; }

    [JsonPropertyName("toolCalls")]
    public IList<AGUIToolCall>? ToolCalls { get; set; }
}
