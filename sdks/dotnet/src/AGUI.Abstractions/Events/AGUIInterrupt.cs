using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIInterrupt
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("toolCallId")]
    public string? ToolCallId { get; set; }

    [JsonPropertyName("responseSchema")]
    public JsonElement? ResponseSchema { get; set; }

    [JsonPropertyName("expiresAt")]
    public string? ExpiresAt { get; set; }

    [JsonPropertyName("metadata")]
    public JsonElement? Metadata { get; set; }
}
