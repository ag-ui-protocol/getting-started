using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Represents a message that is a response from a tool.
/// </summary>
/// <remarks>
/// <para>
/// This is used for scenarios where the agent has requested the frontend to call a tool, and the frontend is dispatching the result of the call to the agent.
/// </para>
/// <para>
/// NOTE: This message is received in a subsequent run after the one the agent requested the tool call in.
/// </para>
/// </remarks>
public sealed record ToolMessage : BaseMessage
{
    [JsonPropertyName("toolCallId")]
    public required string ToolCallId { get; init; }

    [JsonPropertyName("content")]
    public required string Content { get; init; }
}
