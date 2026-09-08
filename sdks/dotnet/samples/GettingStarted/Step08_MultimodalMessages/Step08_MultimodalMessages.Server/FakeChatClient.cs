using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Step08_MultimodalMessages.Server;

internal sealed class FakeChatClient : IChatClient
{
    private readonly Queue<Func<IEnumerable<ChatMessage>, IAsyncEnumerable<ChatResponseUpdate>>> _handlers = new();

    internal void Enqueue(Func<IEnumerable<ChatMessage>, IAsyncEnumerable<ChatResponseUpdate>> handler)
    {
        _handlers.Enqueue(handler);
    }

    public void Dispose()
    {
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        if (serviceType == typeof(IChatClient))
        {
            return this;
        }

        return null;
    }

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        throw new NotSupportedException("Use GetStreamingResponseAsync for AG-UI.");
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (_handlers.Count > 0)
        {
            var handler = _handlers.Dequeue();
            await foreach (var update in handler(messages).WithCancellation(cancellationToken).ConfigureAwait(false))
            {
                yield return update;
            }
            yield break;
        }

        // No handler enqueued: return a deterministic canned response so the sample
        // is runnable end-to-end without LLM credentials. Tests always pre-enqueue.
        var lastUserText = messages.LastOrDefault(m => m.Role == ChatRole.User)?.Text ?? string.Empty;
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new TextContent($"(fake) You said: \"{lastUserText}\"")],
            ModelId = "fake-model",
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
