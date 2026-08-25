using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIToolApprovalPayload
{
    [JsonPropertyName("toolCall")]
    public AGUIToolCallInfo? ToolCall { get; set; }
}
