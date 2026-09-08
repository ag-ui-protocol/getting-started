using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIBinaryInputContent : AGUIInputContent
{
    public override string Type => AGUIInputContentTypes.Binary;

    [JsonPropertyName("mimeType")]
    public string MimeType { get; set; } = string.Empty;

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("url")]
#pragma warning disable CA1056 // URI-like properties should not be strings - AG-UI wire format uses string
    public string? Url { get; set; }
#pragma warning restore CA1056

    [JsonPropertyName("data")]
    public string? Data { get; set; }

    [JsonPropertyName("filename")]
    public string? Filename { get; set; }
}
