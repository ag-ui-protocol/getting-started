using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

[JsonConverter(typeof(AGUIInputContentSourceJsonConverter))]
// Keep in sync with sdks/typescript/packages/core/src/types.ts
public abstract class AGUIInputContentSource
{
    [JsonPropertyName("type")]
    public abstract string Type { get; }
}
