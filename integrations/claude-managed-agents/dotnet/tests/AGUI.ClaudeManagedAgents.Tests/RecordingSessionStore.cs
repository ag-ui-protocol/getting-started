using System.Text.Json;

namespace AGUI.ClaudeManagedAgents.Tests;

/// <summary>
/// A stand-in for a real out-of-process session store: every read and write crosses a
/// serialization boundary, so the agent can never observe an unpersisted in-place mutation
/// through a record it handed the store. The write log makes the persistence points of a run
/// directly assertable.
/// </summary>
public sealed class RecordingSessionStore : ISessionStore
{
    private readonly Dictionary<string, string> _records = new(StringComparer.Ordinal);

    /// <summary>Every record written, in order, as an independent snapshot.</summary>
    public List<(string Key, ManagedAgentsSessionRecord Record)> Writes { get; } = [];

    /// <summary>Every key deleted, in order.</summary>
    public List<string> Deletes { get; } = [];

    /// <summary>When set, <see cref="SetAsync"/> throws this instead of writing.</summary>
    public Exception? SetError { get; set; }

    /// <summary>The keys currently holding a record.</summary>
    public IReadOnlyCollection<string> Keys => _records.Keys;

    public ValueTask<ManagedAgentsSessionRecord?> GetAsync(string threadKey, CancellationToken cancellationToken)
    {
        return new ValueTask<ManagedAgentsSessionRecord?>(
            _records.TryGetValue(threadKey, out var json)
                ? JsonSerializer.Deserialize<ManagedAgentsSessionRecord>(json)
                : null);
    }

    public ValueTask SetAsync(string threadKey, ManagedAgentsSessionRecord record, CancellationToken cancellationToken)
    {
        if (SetError is not null)
        {
            return ValueTask.FromException(SetError);
        }

        var json = JsonSerializer.Serialize(record);
        _records[threadKey] = json;
        Writes.Add((threadKey, JsonSerializer.Deserialize<ManagedAgentsSessionRecord>(json)!));
        return default;
    }

    public ValueTask DeleteAsync(string threadKey, CancellationToken cancellationToken)
    {
        _records.Remove(threadKey);
        Deletes.Add(threadKey);
        return default;
    }
}
