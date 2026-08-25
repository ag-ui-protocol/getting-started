using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIToolCall
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; set; } = "function";

    [JsonPropertyName("function")]
    public AGUIToolCallFunction Function { get; set; } = new();

    [JsonPropertyName("encryptedValue")]
    public string? EncryptedValue { get; set; }

    /// <summary>
    /// Extra information attached to this tool call, open by key.
    /// </summary>
    /// <remarks>
    /// A tool call is not a message, so it carries its own metadata rather than
    /// folding into the assistant message that owns it — several tool calls can
    /// share one parent.
    /// </remarks>
    [JsonPropertyName("metadata")]
    public JsonElement? Metadata { get; set; }
}
