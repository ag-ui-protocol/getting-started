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
    /// Gets or sets the identifier of the subagent this event opens. Every event
    /// the subagent goes on to produce carries this same value in its
    /// <c>subagentId</c>.
    /// </summary>
    [JsonPropertyName("subagentId")]
    public string? SubagentId { get; set; }

    /// <summary>
    /// Gets or sets the subagent's display name.
    /// </summary>
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    /// <summary>
    /// Gets or sets an optional human-readable description of what the subagent does.
    /// </summary>
    [JsonPropertyName("description")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Description { get; set; }

    /// <summary>
    /// Gets or sets the identifier of the subagent that spawned this one, absent for a
    /// subagent the parent run started directly. Nesting is established by this
    /// identity link rather than by the order events arrive in.
    /// </summary>
    [JsonPropertyName("parentSubagentId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ParentSubagentId { get; set; }

    /// <summary>
    /// Gets or sets the identifier of the tool call that spawned this subagent, for the
    /// agents-as-tools pattern. Lets a consumer correlate the subagent with its
    /// spawning call without inspecting <see cref="BaseEvent.RawEvent"/>.
    /// </summary>
    [JsonPropertyName("parentToolCallId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ParentToolCallId { get; set; }

    /// <summary>
    /// Gets or sets the identifier of the message that held the spawning tool call.
    /// </summary>
    [JsonPropertyName("parentMessageId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ParentMessageId { get; set; }
}
