using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUITextInputContent : AGUIInputContent
{
    public override string Type => AGUIInputContentTypes.Text;

    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;
}
