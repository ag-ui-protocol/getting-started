namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Where thread↔session mappings live. The default is in-memory (lost on restart, in which case
/// a fresh session is created). Provide your own to survive restarts or run multiple replicas.
/// </summary>
/// <remarks>
/// The <c>threadKey</c> is opaque: it is derived from the managed agent id and the AG-UI
/// thread id (<c>managedAgentId:threadId</c>), so two agents sharing one store never adopt each
/// other's sessions. Treat it as a string to store under, not as a thread id to parse. Thread ids
/// are client-supplied, so put the endpoint behind your own authentication and supply a store that
/// partitions by caller if you need multi-tenant isolation.
/// </remarks>
public interface ISessionStore
{
    /// <summary>
    /// Gets the record stored under <paramref name="threadKey"/>, or <see langword="null"/> if none exists.
    /// </summary>
    ValueTask<ManagedAgentsSessionRecord?> GetAsync(string threadKey, CancellationToken cancellationToken);

    /// <summary>
    /// Stores <paramref name="record"/> under <paramref name="threadKey"/>, replacing any existing record.
    /// </summary>
    ValueTask SetAsync(string threadKey, ManagedAgentsSessionRecord record, CancellationToken cancellationToken);

    /// <summary>
    /// Removes the record stored under <paramref name="threadKey"/>, if any.
    /// </summary>
    ValueTask DeleteAsync(string threadKey, CancellationToken cancellationToken);
}
