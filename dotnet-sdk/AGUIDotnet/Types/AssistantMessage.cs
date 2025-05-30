using System.Collections.Immutable;
using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a message from an assistant.
/// </summary>
public sealed record AssistantMessage : BaseMessage
{
    [JsonPropertyName("content")]
    public string? Content { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("toolCalls")]
    public ImmutableList<ToolCall> ToolCalls { get; init; } = [];
}
