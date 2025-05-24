using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a message sent by the user.
/// </summary>
public sealed record UserMessage : BaseMessage
{
    [JsonPropertyName("content")]
    public required string Content { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }
}
