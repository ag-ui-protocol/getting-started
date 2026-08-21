using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIResume
{
    [JsonPropertyName("interruptId")]
    public string InterruptId { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = ResumeStatus.Resolved;

    [JsonPropertyName("payload")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Payload { get; set; }

    /// <summary>
    /// Extra information attached to this resume entry, open by key.
    /// </summary>
    /// <remarks>
    /// Envelope data about the response — signatures, routing keys — as opposed
    /// to <see cref="Payload"/>, which is the answer the agent asked for and
    /// will act on. Any JSON value is allowed under a key, including
    /// <c>null</c>. The object itself is absent or an object, never <c>null</c>.
    ///
    /// The <c>ag-ui</c> key is reserved for AG-UI's own use; see <see
    /// cref="AGUIMetadata.ReservedKey"/>.
    /// </remarks>
    [JsonPropertyName("metadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Metadata { get; set; }
}
