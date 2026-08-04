namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// The limits shared with the TypeScript and Python ports, so all three shape and truncate
/// content the same way.
/// </summary>
internal static class ManagedAgentsLimits
{
    /// <summary>Tool results can be large; the UI only needs a readable prefix.</summary>
    internal const int ToolResultMaxChars = 4000;

    /// <summary>Search result bodies can be long; show only a readable prefix.</summary>
    internal const int SearchResultPreviewChars = 300;

    /// <summary>Managed Agents tool names are at most 128 characters.</summary>
    internal const int ToolNameMaxLength = 128;

    /// <summary>Tool descriptions are capped by the API at 1-4096 characters.</summary>
    internal const int ToolDescriptionMaxLength = 4096;

    /// <summary>
    /// How many thread↔session mappings the default in-memory store keeps. Thread ids are
    /// client-supplied, so the map has to be bounded; past this the least-recently-used mapping is
    /// evicted and that thread starts a fresh session on its next run.
    /// </summary>
    internal const int InMemorySessionStoreMaxEntries = 10_000;

    /// <summary>The default limit after which a turn is interrupted.</summary>
    internal static readonly TimeSpan DefaultTurnTimeout = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Bound on best-effort sends that must survive the run's own cancellation (tool results,
    /// confirmations): long enough for a healthy API call, short enough that a stalled
    /// connection cannot hold the thread's run gate open.
    /// </summary>
    internal static readonly TimeSpan BestEffortSendTimeout = TimeSpan.FromSeconds(15);

    /// <summary>
    /// Delays between attempts to post a follow-up message that raced the session's un-park
    /// (seven attempts in total).
    /// </summary>
    internal static readonly TimeSpan[] SentWhileParkedRetryDelays =
    [
        TimeSpan.FromMilliseconds(150),
        TimeSpan.FromMilliseconds(300),
        TimeSpan.FromMilliseconds(600),
        TimeSpan.FromMilliseconds(1000),
        TimeSpan.FromMilliseconds(1500),
        TimeSpan.FromMilliseconds(2000),
    ];
}
