using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event signaling that a subagent failed. Terminal for the subagent it names, and the
/// counterpart to <see cref="SubagentFinishedEvent"/> — a subagent ends with exactly one
/// of the two, never both. That is enforced before <c>RUN_FINISHED</c> only: a run that ends
/// with <c>RUN_ERROR</c> may leave its subagents unclosed. Events attributed to it
/// afterwards remain valid — a continuation carries the tag of the subagent it belongs to
/// even after that subagent has ended.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class SubagentErrorEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.SubagentError;

    /// <summary>
    /// Gets or sets the identifier of the subagent that failed.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }

    /// <summary>
    /// Gets or sets the error message.
    /// </summary>
    [JsonPropertyName("message")]
    public string? Message { get; set; }

    /// <summary>
    /// Gets or sets an optional machine-readable error code.
    /// </summary>
    [JsonPropertyName("code")]
    public string? Code { get; set; }
}
