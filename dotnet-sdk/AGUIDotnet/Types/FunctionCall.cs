using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a function call made by the agent.
/// </summary>
public sealed record FunctionCall
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    /// <summary>
    /// The JSON-encoded arguments (as a string) for the function call.
    /// </summary>
    [JsonPropertyName("arguments")]
    public required string Arguments { get; init; }
}
