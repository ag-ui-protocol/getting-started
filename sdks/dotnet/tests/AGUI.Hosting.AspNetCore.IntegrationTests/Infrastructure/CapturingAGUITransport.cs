using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Client;

namespace AGUI.Server.IntegrationTests;

internal sealed class CapturingAGUITransport : IAGUITransport
{
    private readonly IAGUITransport _inner;
    private readonly List<TurnCapture> _turns = new();

    internal CapturingAGUITransport(IAGUITransport inner)
    {
        _inner = inner;
    }

    internal IReadOnlyList<TurnCapture> Turns => _turns;

    public async IAsyncEnumerable<BaseEvent> SendAsync(
        RunAgentInput input,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var events = new List<BaseEvent>();
        await foreach (var evt in _inner.SendAsync(input, cancellationToken).ConfigureAwait(false))
        {
            events.Add(evt);
            yield return evt;
        }

        _turns.Add(new TurnCapture(input, events));
    }
}
