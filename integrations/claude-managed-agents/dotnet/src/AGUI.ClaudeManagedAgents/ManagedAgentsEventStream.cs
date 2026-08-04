using Anthropic.Models.Beta.Sessions.Events;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// An open server-sent event stream of a managed session. Disposing it closes the underlying
/// connection.
/// </summary>
public sealed class ManagedAgentsEventStream : IAsyncEnumerable<BetaManagedAgentsStreamSessionEvents>, IAsyncDisposable
{
    private readonly IAsyncEnumerable<BetaManagedAgentsStreamSessionEvents> _events;
    private readonly Func<ValueTask>? _dispose;
    private bool _disposed;

    /// <summary>
    /// Initializes a new instance of the <see cref="ManagedAgentsEventStream"/> class.
    /// </summary>
    /// <param name="events">The session events, already connected.</param>
    /// <param name="dispose">Releases the underlying connection, if any.</param>
    public ManagedAgentsEventStream(
        IAsyncEnumerable<BetaManagedAgentsStreamSessionEvents> events,
        Func<ValueTask>? dispose = null)
    {
        ArgumentNullException.ThrowIfNull(events);
        _events = events;
        _dispose = dispose;
    }

    /// <inheritdoc />
    public IAsyncEnumerator<BetaManagedAgentsStreamSessionEvents> GetAsyncEnumerator(CancellationToken cancellationToken = default)
    {
        return _events.GetAsyncEnumerator(cancellationToken);
    }

    /// <inheritdoc />
    public ValueTask DisposeAsync()
    {
        if (_disposed || _dispose is null)
        {
            return default;
        }

        _disposed = true;
        return _dispose();
    }
}
