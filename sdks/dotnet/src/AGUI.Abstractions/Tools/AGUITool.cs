using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Represents a tool available for the agent to use.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUITool
{
    /// <summary>
    /// Gets or sets the name of the tool.
    /// </summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the description of the tool.
    /// </summary>
    [JsonPropertyName("description")]
    public string? Description { get; set; }

    /// <summary>
    /// Gets or sets the JSON Schema describing the tool's parameters.
    /// </summary>
    /// <remarks>
    /// A parameterless tool leaves this unset, which writes nothing rather than <c>null</c> —
    /// matching TypeScript, where <c>parameters</c> is <c>z.any()</c> and simply absent.
    /// <see cref="JsonIgnoreCondition.WhenWritingDefault"/> rather than the context-wide
    /// <see cref="JsonIgnoreCondition.WhenWritingNull"/>, because a non-nullable
    /// <see cref="JsonElement"/> is never null: unset it holds
    /// <see cref="JsonValueKind.Undefined"/>, which the serializer cannot write at all.
    /// </remarks>
    [JsonPropertyName("parameters")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public JsonElement Parameters { get; set; }

    /// <summary>
    /// Gets or sets arbitrary tool metadata (e.g. a2ui schema).
    /// </summary>
    [JsonPropertyName("metadata")]
    public JsonElement? Metadata { get; set; }
}
