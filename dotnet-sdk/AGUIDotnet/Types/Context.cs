using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a context object to provide additional information to the agent.
/// </summary>
public sealed record Context
{
    [JsonPropertyName("description")]
    public required string Description { get; init; }

    [JsonPropertyName("value")]
    public required string Value { get; init; }
}
