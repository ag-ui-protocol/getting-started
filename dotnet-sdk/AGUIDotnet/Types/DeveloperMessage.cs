using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a message from a developer.
/// </summary>
public sealed record DeveloperMessage : BaseMessage
{
    [JsonPropertyName("content")]
    public required string Content { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }
}
