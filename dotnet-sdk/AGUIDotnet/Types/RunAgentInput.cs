using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

public sealed record RunAgentInput
{
    /// <summary>
    /// ID of the conversation thread.
    /// </summary>
    [JsonPropertyName("threadId")]
    public required string ThreadId { get; init; }

    /// <summary>
    /// ID of the current run.
    /// </summary>
    [JsonPropertyName("runId")]
    public required string RunId { get; init; }

    /// <summary>
    /// The current state of the agent, at the time of the agent being called.
    /// </summary>
    [JsonPropertyName("state")]
    public required JsonElement State { get; init; }

    /// <summary>
    /// The messages that are part of the conversation thread.
    /// </summary>
    [JsonPropertyName("messages")]
    public required ImmutableList<BaseMessage> Messages { get; init; } = [];

    /// <summary>
    /// Tools available to the agent from the caller.
    /// </summary>
    [JsonPropertyName("tools")]
    public required ImmutableList<Tool> Tools { get; init; } = [];

    /// <summary>
    /// Context items that provide additional information to the agent.
    /// </summary>
    [JsonPropertyName("context")]
    public required ImmutableList<Context> Context { get; init; } = [];

    /// <summary>
    /// Additional forwarded properties that are passed to the agent.
    /// </summary>
    [JsonPropertyName("forwardedProps")]
    public required JsonElement ForwardedProps { get; init; }
}