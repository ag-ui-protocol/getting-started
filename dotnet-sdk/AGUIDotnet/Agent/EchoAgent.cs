using System.Threading.Channels;
using AGUIDotnet.Events;
using AGUIDotnet.Types;

namespace AGUIDotnet.Agent;

/// <summary>
/// Bare-bones agent reference implementation that echoes the last message received.
/// This agent is useful for testing and debugging purposes.
/// </summary>
public sealed class EchoAgent : IAGUIAgent
{
    public async Task RunAsync(
        RunAgentInput input,
        ChannelWriter<BaseEvent> events,
        CancellationToken ct = default
    )
    {
        await events.WriteAsync(
            new RunStartedEvent
            {
                ThreadId = input.ThreadId,
                RunId = input.RunId,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            },
            ct
        ).ConfigureAwait(false);

        var lastMessage = input.Messages.LastOrDefault();

        await Task.Delay(500, ct).ConfigureAwait(false);

        switch (lastMessage)
        {
            case SystemMessage system:
                foreach (var ev in EventHelpers.SendSimpleMessage(
                    $"Echoing system message:\n\n```\n{system.Content}\n```\n"
                ))
                {
                    await events.WriteAsync(ev, ct).ConfigureAwait(false);
                }
                break;

            case UserMessage user:
                foreach (var ev in EventHelpers.SendSimpleMessage(
                    $"Echoing user message:\n\n```\n{user.Content}\n```\n"
                ))
                {
                    await events.WriteAsync(ev, ct).ConfigureAwait(false);
                }
                break;

            case AssistantMessage assistant:
                foreach (var ev in EventHelpers.SendSimpleMessage(
                    $"Echoing assistant message:\n\n```\n{assistant.Content}\n```\n"
                ))
                {
                    await events.WriteAsync(ev, ct).ConfigureAwait(false);
                }
                break;

            case ToolMessage tool:
                foreach (var ev in EventHelpers.SendSimpleMessage(
                    $"Echoing tool message for tool call '{tool.ToolCallId}':\n\n```\n{tool.Content}\n```\n"
                ))
                {
                    await events.WriteAsync(ev, ct).ConfigureAwait(false);
                }
                break;

            default:
                foreach (var ev in EventHelpers.SendSimpleMessage(
                    $"Unknown message type: {lastMessage?.GetType().Name ?? "null"}"
                ))
                {
                    await events.WriteAsync(ev, ct).ConfigureAwait(false);
                }
                break;
        }

        await events.WriteAsync(
            new RunFinishedEvent
            {
                ThreadId = input.ThreadId,
                RunId = input.RunId,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            },
            ct
        ).ConfigureAwait(false);

        events.Complete();
    }
}
