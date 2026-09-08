namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// What a swallowed best-effort failure was doing when it failed.
/// </summary>
public sealed class ManagedAgentsErrorContext
{
    /// <summary>Gets the stable identifier for the operation, e.g. <c>"interrupt"</c>.</summary>
    public required string Operation { get; init; }

    /// <summary>Gets the managed session the operation targeted, when known.</summary>
    public string? SessionId { get; init; }

    /// <summary>Gets the AG-UI thread the operation belonged to, when known.</summary>
    public string? ThreadId { get; init; }
}
