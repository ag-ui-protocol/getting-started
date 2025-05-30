using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a tool call made by an agent.
/// </summary>
public sealed record ToolCall
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("type")]
#pragma warning disable CA1822 // Mark members as static
    public string Type => "function";
#pragma warning restore CA1822 // Mark members as static

    [JsonPropertyName("function")]
    public required FunctionCall Function { get; init; }
}
