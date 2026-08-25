using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public abstract class AGUIMediaInputContent : AGUIInputContent
{
    [JsonPropertyName("source")]
    public AGUIInputContentSource Source { get; set; } = null!;

    [JsonPropertyName("metadata")]
    public JsonElement? Metadata { get; set; }
}
