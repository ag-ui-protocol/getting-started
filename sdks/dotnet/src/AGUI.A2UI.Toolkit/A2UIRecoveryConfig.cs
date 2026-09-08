namespace AGUI.A2UI;

/// <summary>
/// Configuration for the A2UI generation recovery loop.
/// </summary>
public sealed class A2UIRecoveryConfig
{
    /// <summary>
    /// Gets the maximum number of generation attempts. Defaults to
    /// <see cref="A2UIConstants.MaxA2UIAttempts"/> when unset.
    /// </summary>
    public int? MaxAttempts { get; init; }
}
