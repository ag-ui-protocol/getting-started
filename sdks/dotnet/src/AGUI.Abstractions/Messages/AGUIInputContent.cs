using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

[JsonConverter(typeof(AGUIInputContentJsonConverter))]
// Keep in sync with sdks/typescript/packages/core/src/types.ts
public abstract class AGUIInputContent
{
    [JsonPropertyName("type")]
    public abstract string Type { get; }
}
