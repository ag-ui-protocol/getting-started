using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIInputContentUrlSource : AGUIInputContentSource
{
    public override string Type => AGUIInputContentSourceTypes.Url;

    [JsonPropertyName("value")]
#pragma warning disable CA1056 // URI-like properties should not be strings - AG-UI wire format uses string
    public string Value { get; set; } = string.Empty;
#pragma warning restore CA1056

    [JsonPropertyName("mimeType")]
    public string? MimeType { get; set; }
}
