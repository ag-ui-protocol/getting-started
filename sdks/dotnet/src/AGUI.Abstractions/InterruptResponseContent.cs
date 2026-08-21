using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Represents the response to an <see cref="InterruptRequestContent"/>, carrying the
/// user-provided data back to the agent. The <see cref="Payload"/> shape is determined
/// by the interrupt reason and matches the contract expected by the original request.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/types.ts
// See InterruptRequestContent: this type is registered onto caller-owned
// JsonSerializerOptions, so its [JsonIgnore(WhenWritingNull)] attribute is load-bearing
// rather than redundant with AGUIJsonSerializerContext's DefaultIgnoreCondition.
public sealed class InterruptResponseContent : Microsoft.Extensions.AI.InputResponseContent
{
    /// <summary>
    /// Initializes a new instance of the <see cref="InterruptResponseContent"/> class.
    /// </summary>
    /// <param name="requestId">The unique identifier that correlates this response with its corresponding request.</param>
    [JsonConstructor]
    public InterruptResponseContent(string requestId)
        : base(requestId)
    {
    }

    /// <summary>
    /// Gets or sets the opaque payload associated with the interrupt response.
    /// </summary>
    [JsonPropertyName("payload")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Payload { get; set; }

    /// <summary>
    /// Gets or sets extra information attached to the resume entry this response
    /// becomes, open by key.
    /// </summary>
    /// <remarks>
    /// Envelope data about the response — signatures, routing keys — as opposed
    /// to <see cref="Payload"/>, which is the answer the agent asked for and
    /// will act on. Carried to and from <see cref="AGUIResume.Metadata"/> by the
    /// client and hosting adapters. The <c>ag-ui</c> key is reserved for AG-UI's
    /// own use; see <see cref="AGUIMetadata.ReservedKey"/>.
    /// </remarks>
    [JsonPropertyName("metadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Metadata { get; set; }
}
