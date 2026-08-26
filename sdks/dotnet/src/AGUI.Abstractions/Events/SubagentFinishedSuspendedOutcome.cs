using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Outcome variant signalling that a subagent is paused awaiting outside input.
/// The subagent's stream segment closes for THIS run (the run itself ends with
/// an interrupt outcome); on resume the same subagentRunId is re-announced as a
/// continuation of the suspended invocation.
/// </summary>
public sealed class SubagentFinishedSuspendedOutcome : SubagentFinishedOutcome
{
    /// <inheritdoc/>
    public override string Type => SubagentFinishedOutcomeTypes.Suspended;

    /// <summary>
    /// Gets or sets the ids of the run-level interrupts this subagent directly
    /// owns (see <see cref="AGUIInterrupt.SubagentRunId"/>). MAY be null or
    /// empty: an ancestor subagent suspended because a DESCENDANT interrupted
    /// owns no interrupt itself.
    /// </summary>
    [JsonPropertyName("interruptIds")]
    public IList<string>? InterruptIds { get; set; }
}
