using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Defines a tool that can be called by an agent.
/// </summary>
public sealed record Tool
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("description")]
    public required string Description { get; init; }

    /// <summary>
    /// The JSON schema for the parameters that this tool accepts
    /// </summary>
    [JsonPropertyName("parameters")]
    public required JsonElement Parameters { get; init; }
}