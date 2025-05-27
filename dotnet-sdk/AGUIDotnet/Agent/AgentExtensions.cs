using System.Runtime.CompilerServices;
using System.Threading.Channels;
using AGUIDotnet.Events;
using AGUIDotnet.Types;

namespace AGUIDotnet.Agent;

public static class AgentExtensions
{
    /// <summary>
    /// Runs the provided agent asynchronously to completion, yielding the events produced by the agent.
    /// </summary>
    /// <param name="agent">The <see cref="IAGUIAgent"/> instance to invoke</param>
    /// <param name="input">The <see cref="RunAgentInput"/> input to pass to the agent</param>
    /// <param name="cancellationToken">The cancellation token to cancel the run</param>
    /// <returns>An <see cref="IAsyncEnumerable{T}"/> with the events produced by the agent</returns>
    public static async IAsyncEnumerable<BaseEvent> RunToCompletionAsync(
        this IAGUIAgent agent,
        RunAgentInput input,
        [EnumeratorCancellation] CancellationToken cancellationToken = default
    )
    {
        ArgumentNullException.ThrowIfNull(agent, nameof(agent));
        ArgumentNullException.ThrowIfNull(input, nameof(input));

        var channel = Channel.CreateUnbounded<BaseEvent>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = true
        });

        // Invoke the agent in a separate throwaway task to run asynchronously.
        _ = Task.Run(async () =>
        {
            try
            {
                await agent.RunAsync(input, channel.Writer, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                // Operation was cancelled, we can ignore this.
            }
            catch (Exception ex)
            {
                // An error occurred while running the agent, try to complete the channel with exception detail if possible.
                try
                {
                    channel.Writer.Complete(ex);
                }
                catch (ChannelClosedException)
                {
                    // Channel was already closed by the agent, we can ignore this.
                }
            }
        }, cancellationToken);

        // Enumerate the events produced by the agent and yield them to the caller.
        await foreach (var ev in channel.Reader.ReadAllAsync(cancellationToken))
        {
            yield return ev;
        }
    }
}
