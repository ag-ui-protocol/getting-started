using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event signaling that a subagent has begun work on the parent's behalf.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class SubagentStartedEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.SubagentStarted;

    /// <summary>
    /// Gets or sets the identifier of the subagent this event opens. It is the value the
    /// subagent's later events use in their <c>subagentRunId</c> to attribute themselves to
    /// it — attribution is optional per event, so an untagged continuation of something this
    /// subagent opened is equally valid.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }

    /// <summary>
    /// Gets or sets the subagent's display name.
    /// </summary>
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    /// <summary>
    /// Gets or sets an optional human-readable description of what the subagent does.
    /// </summary>
    [JsonPropertyName("description")]
    public string? Description { get; set; }

    /// <summary>
    /// Gets or sets the identifier of the subagent that spawned this one, absent for a
    /// subagent the parent run started directly. Nesting is established by this
    /// identity link rather than by the order events arrive in.
    /// </summary>
    [JsonPropertyName("parentSubagentRunId")]
    public string? ParentSubagentRunId { get; set; }

    /// <summary>
    /// Gets or sets the identifier of the tool call that spawned this subagent, for the
    /// agents-as-tools pattern. Lets a consumer correlate the subagent with its
    /// spawning call without inspecting <see cref="BaseEvent.RawEvent"/>.
    /// </summary>
    [JsonPropertyName("parentToolCallId")]
    public string? ParentToolCallId { get; set; }

    /// <summary>
    /// Gets or sets the identifier of the message that held the spawning tool call.
    /// </summary>
    [JsonPropertyName("parentMessageId")]
    public string? ParentMessageId { get; set; }
}
