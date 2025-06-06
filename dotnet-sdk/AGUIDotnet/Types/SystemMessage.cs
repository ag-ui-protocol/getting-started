using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a system message.
/// </summary>
public sealed record SystemMessage : BaseMessage
{
    [JsonPropertyName("content")]
    public required string Content { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }
}
