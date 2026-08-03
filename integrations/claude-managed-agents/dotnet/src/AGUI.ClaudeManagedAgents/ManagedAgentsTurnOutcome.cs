namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// How a turn ended.
/// </summary>
internal enum ManagedAgentsTurnStatus
{
    /// <summary>The session went idle after the reply completed.</summary>
    Finished,

    /// <summary>The session is parked on custom tool calls the frontend must answer.</summary>
    Parked,

    /// <summary>A <c>RUN_ERROR</c> was already emitted.</summary>
    Errored,
}

/// <summary>
/// The result of driving one turn of a managed session.
/// </summary>
/// <remarks>
/// Immutable and only constructible through the factories below, which makes the invalid states
/// unrepresentable: a parked outcome always carries at least one tool call the frontend must
/// answer, and no other status ever carries one.
/// </remarks>
internal sealed class ManagedAgentsTurnOutcome
{
    private ManagedAgentsTurnOutcome(
        ManagedAgentsTurnStatus status,
        IReadOnlyList<string> clientToolUseIds,
        bool sessionEnded = false,
        bool sessionInterrupted = false)
    {
        Status = status;
        ClientToolUseIds = clientToolUseIds;
        SessionEnded = sessionEnded;
        SessionInterrupted = sessionInterrupted;
    }

    /// <summary>The session went idle after the reply completed.</summary>
    internal static ManagedAgentsTurnOutcome Finished { get; } = new(ManagedAgentsTurnStatus.Finished, []);

    /// <summary>A <c>RUN_ERROR</c> was already emitted for this turn.</summary>
    internal static ManagedAgentsTurnOutcome Errored { get; } = new(ManagedAgentsTurnStatus.Errored, []);

    /// <summary>
    /// A <c>RUN_ERROR</c> was already emitted, and a <c>user.interrupt</c> reached the session
    /// first — which cancels whatever it was waiting on, so any park recorded during this turn is
    /// no longer answerable and must not be carried into the next run.
    /// </summary>
    internal static ManagedAgentsTurnOutcome ErroredAfterInterrupt { get; } =
        new(ManagedAgentsTurnStatus.Errored, [], sessionInterrupted: true);

    /// <summary>
    /// <see cref="Errored"/> or <see cref="ErroredAfterInterrupt"/>, according to whether the
    /// interrupt that preceded the failure actually landed.
    /// </summary>
    internal static ManagedAgentsTurnOutcome ErroredWith(bool sessionInterrupted)
    {
        return sessionInterrupted ? ErroredAfterInterrupt : Errored;
    }

    /// <summary>
    /// A <c>RUN_ERROR</c> was already emitted because the session itself ended on the server
    /// (terminated or deleted), so the thread's record must be dropped.
    /// </summary>
    internal static ManagedAgentsTurnOutcome ErroredSessionEnded { get; } = new(ManagedAgentsTurnStatus.Errored, [], sessionEnded: true);

    /// <summary>
    /// The session is parked on <paramref name="clientToolUseIds"/>, which the frontend must
    /// answer on its next run.
    /// </summary>
    /// <exception cref="ArgumentException">
    /// <paramref name="clientToolUseIds"/> is empty. A park with nothing to answer would leave
    /// the session waiting on a call the next run cannot identify.
    /// </exception>
    internal static ManagedAgentsTurnOutcome Parked(IReadOnlyList<string> clientToolUseIds)
    {
        ArgumentNullException.ThrowIfNull(clientToolUseIds);
        if (clientToolUseIds.Count == 0)
        {
            throw new ArgumentException("A parked outcome must carry at least one tool call id.", nameof(clientToolUseIds));
        }

        return new ManagedAgentsTurnOutcome(ManagedAgentsTurnStatus.Parked, clientToolUseIds);
    }

    internal ManagedAgentsTurnStatus Status { get; }

    /// <summary>Custom tool calls the frontend must answer. Empty unless <see cref="Status"/> is parked.</summary>
    internal IReadOnlyList<string> ClientToolUseIds { get; }

    /// <summary>Whether the session itself ended on the server (terminated or deleted).</summary>
    internal bool SessionEnded { get; }

    /// <summary>Whether a <c>user.interrupt</c> reached the session.</summary>
    internal bool SessionInterrupted { get; }
}
