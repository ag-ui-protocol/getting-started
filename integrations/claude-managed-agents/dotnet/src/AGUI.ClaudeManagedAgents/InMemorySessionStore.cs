namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// In-memory thread↔session store. Mappings are lost on restart.
/// </summary>
/// <remarks>
/// Bounded: thread ids come from the client, so an unbounded map is a memory leak an untrusted
/// caller controls. Once the capacity is reached the least-recently-used mapping is dropped —
/// which costs that thread its history (the next run starts a fresh session), so a deployment that
/// cannot afford that should supply a persistent store instead.
/// </remarks>
public sealed class InMemorySessionStore : ISessionStore
{
    private readonly int _maxEntries;
    private readonly object _gate = new();

    // Insertion order is the recency order: a read or write re-inserts its key, so the oldest
    // entry is always the first one enumeration yields. A plain dictionary plus a lock rather than
    // a ConcurrentDictionary, because eviction has to see a consistent order.
    private readonly Dictionary<string, ManagedAgentsSessionRecord> _records = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _recency = new();
    private readonly Dictionary<string, LinkedListNode<string>> _nodes = new(StringComparer.Ordinal);

    /// <summary>
    /// Initializes a new instance of the <see cref="InMemorySessionStore"/> class.
    /// </summary>
    /// <param name="maxEntries">
    /// How many mappings to keep before evicting the least recently used one. Defaults to
    /// <see cref="ManagedAgentsLimits.InMemorySessionStoreMaxEntries"/>.
    /// </param>
    public InMemorySessionStore(int maxEntries = ManagedAgentsLimits.InMemorySessionStoreMaxEntries)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxEntries, 1);
        _maxEntries = maxEntries;
    }

    /// <summary>
    /// A defensive copy of a record. The store must not hand out a reference to the record it
    /// holds: the agent mutates records in place between persists, so an aliased record would
    /// make an unpersisted mutation indistinguishable from a persisted one — and a dropped write
    /// would only surface against a real out-of-process store.
    /// </summary>
    private static ManagedAgentsSessionRecord Copy(ManagedAgentsSessionRecord record) => new()
    {
        SessionId = record.SessionId,
        ToolNames = [.. record.ToolNames],
        ToolDefinitionsFingerprint = record.ToolDefinitionsFingerprint,
        LastUserMessageId = record.LastUserMessageId,
        PendingClientToolUseIds = [.. record.PendingClientToolUseIds],
    };

    /// <summary>How many mappings are currently held.</summary>
    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _records.Count;
            }
        }
    }

    /// <inheritdoc />
    public ValueTask<ManagedAgentsSessionRecord?> GetAsync(string threadKey, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (!_records.TryGetValue(threadKey, out var record))
            {
                return new ValueTask<ManagedAgentsSessionRecord?>((ManagedAgentsSessionRecord?)null);
            }

            Touch(threadKey);
            return new ValueTask<ManagedAgentsSessionRecord?>(Copy(record));
        }
    }

    /// <inheritdoc />
    public ValueTask SetAsync(string threadKey, ManagedAgentsSessionRecord record, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(record);
        lock (_gate)
        {
            _records[threadKey] = Copy(record);
            Touch(threadKey);
            while (_records.Count > _maxEntries && _recency.First is { } oldest)
            {
                Remove(oldest.Value);
            }
        }

        return default;
    }

    /// <inheritdoc />
    public ValueTask DeleteAsync(string threadKey, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            Remove(threadKey);
        }

        return default;
    }

    private void Touch(string threadKey)
    {
        if (_nodes.TryGetValue(threadKey, out var node))
        {
            _recency.Remove(node);
        }

        _nodes[threadKey] = _recency.AddLast(threadKey);
    }

    private void Remove(string threadKey)
    {
        _records.Remove(threadKey);
        if (_nodes.Remove(threadKey, out var node))
        {
            _recency.Remove(node);
        }
    }
}
