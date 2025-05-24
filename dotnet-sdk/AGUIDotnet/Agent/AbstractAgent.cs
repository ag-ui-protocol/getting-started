using System.Runtime.CompilerServices;
using AGUIDotnet.Events;
using AGUIDotnet.Types;

namespace AGUIDotnet.Agent;

public abstract class AbstractAgent
{
    public abstract IAsyncEnumerable<BaseEvent> RunAsync(RunAgentInput input, CancellationToken cancellationToken = default);
}

public sealed class EchoAgent : AbstractAgent
{
    public override async IAsyncEnumerable<BaseEvent> RunAsync(RunAgentInput input, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        yield return new RunStartedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };

        var lastMessage = input.Messages.LastOrDefault();

        await Task.Delay(500, cancellationToken);

        switch (lastMessage)
        {
            case SystemMessage system:
                foreach (var ev in EventHelpers.SendSimpleMessage($"Echoing system message:\n\n```\n{system.Content}\n```\n"))
                {
                    yield return ev;
                }
                break;

            case UserMessage user:
                foreach (var ev in EventHelpers.SendSimpleMessage($"Echoing user message:\n\n```\n{user.Content}\n```\n"))
                {
                    yield return ev;
                }
                break;

            case AssistantMessage assistant:
                foreach (var ev in EventHelpers.SendSimpleMessage($"Echoing assistant message:\n\n```\n{assistant.Content}\n```\n"))
                {
                    yield return ev;
                }
                break;

            case ToolMessage tool:
                foreach (var ev in EventHelpers.SendSimpleMessage($"Echoing tool message for tool call '{tool.ToolCallId}':\n\n```\n{tool.Content}\n```\n"))
                {
                    yield return ev;
                }
                break;

            default:
                foreach (var ev in EventHelpers.SendSimpleMessage($"Unknown message type: {lastMessage?.GetType().Name ?? "null"}"))
                {
                    yield return ev;
                }
                break;
        }

        yield return new RunFinishedEvent
        {
            ThreadId = input.ThreadId,
            RunId = input.RunId,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
    }
}
