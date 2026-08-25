using System.Collections.Generic;
using System.Threading;
using AGUI.Abstractions;

namespace AGUI.Client;

/// <summary>
/// Defines the transport layer for sending AG-UI protocol requests and receiving event streams.
/// </summary>
public interface IAGUITransport
{
    /// <summary>
    /// Sends a run agent request and returns the resulting event stream.
    /// </summary>
    /// <param name="input">The agent run input containing messages, tools, and state.</param>
    /// <param name="cancellationToken">A token to monitor for cancellation requests.</param>
    /// <returns>An async enumerable of AG-UI events.</returns>
    IAsyncEnumerable<BaseEvent> SendAsync(RunAgentInput input, CancellationToken cancellationToken);
}
