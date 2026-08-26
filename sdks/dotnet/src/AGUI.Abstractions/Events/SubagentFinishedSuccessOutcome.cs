namespace AGUI.Abstractions;

/// <summary>Outcome variant signalling that a subagent completed its work.</summary>
public sealed class SubagentFinishedSuccessOutcome : SubagentFinishedOutcome
{
    /// <inheritdoc/>
    public override string Type => SubagentFinishedOutcomeTypes.Success;
}
