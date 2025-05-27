using System.Threading.Channels;
using AGUIDotnet.Events;
using AGUIDotnet.Types;

namespace AGUIDotnet.Agent;

/// <summary>
/// Interface for an AG-UI agent.
/// </summary>
public interface IAGUIAgent
{
    /// <summary>
    /// Runs the agent with the provided input.
    /// </summary>
    /// <param name="input">The input to the agent</param>
    /// <param name="events">A channel writer for emitting AG-UI protocol events</param>
    /// <param name="cancellationToken">Optional cancellation token for cancelling execution</param>
    /// <returns>An asynchronous task that will complete when agent execution completes for a run</returns>
    Task RunAsync(RunAgentInput input, ChannelWriter<BaseEvent> events, CancellationToken cancellationToken = default);
}
