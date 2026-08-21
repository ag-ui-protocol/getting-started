using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIToolApprovalResumePayload
{
    [JsonPropertyName("approved")]
    public bool Approved { get; set; }

    [JsonPropertyName("toolCall")]
    public AGUIToolCallInfo? ToolCall { get; set; }

    [JsonPropertyName("result")]
    public string? Result { get; set; }
}
