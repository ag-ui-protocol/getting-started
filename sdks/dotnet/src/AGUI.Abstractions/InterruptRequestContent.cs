using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Represents a generic interrupt request that pauses the agent run to request input
/// from the user or application. Carries structured fields from the AG-UI interrupt.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/types.ts
// Unlike the AG-UI wire types, this content type is registered onto caller-owned
// JsonSerializerOptions via AGUIJsonUtilities.RegisterInterruptContentTypes, so it cannot
// inherit the DefaultIgnoreCondition that AGUIJsonSerializerContext bakes into the wire
// types. Its per-property [JsonIgnore(WhenWritingNull)] attributes are therefore
// load-bearing, not redundant — do not remove them.
public sealed class InterruptRequestContent : Microsoft.Extensions.AI.InputRequestContent
{
    /// <summary>
    /// Initializes a new instance of the <see cref="InterruptRequestContent"/> class.
    /// </summary>
    /// <param name="requestId">The unique identifier that correlates this request with its corresponding response.</param>
    [JsonConstructor]
    public InterruptRequestContent(string requestId)
        : base(requestId)
    {
    }

    /// <summary>
    /// Gets or sets the interrupt reason (e.g. "tool_call", "input_required", "confirmation", or a custom value).
    /// </summary>
    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; set; }

    /// <summary>
    /// Gets or sets a human-readable message describing the interrupt.
    /// </summary>
    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; set; }

    /// <summary>
    /// Gets or sets the tool call identifier, when the interrupt is related to a tool call.
    /// </summary>
    [JsonPropertyName("toolCallId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ToolCallId { get; set; }

    /// <summary>
    /// Gets or sets the JSON schema describing the expected response shape.
    /// </summary>
    [JsonPropertyName("responseSchema")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? ResponseSchema { get; set; }

    /// <summary>
    /// Gets or sets the expiration time for the interrupt, as an ISO 8601 string.
    /// </summary>
    [JsonPropertyName("expiresAt")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ExpiresAt { get; set; }

    /// <summary>
    /// Gets or sets additional metadata associated with the interrupt.
    /// </summary>
    [JsonPropertyName("metadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Metadata { get; set; }
}
