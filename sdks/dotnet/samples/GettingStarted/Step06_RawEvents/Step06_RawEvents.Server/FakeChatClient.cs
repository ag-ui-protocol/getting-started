using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Step06_RawEvents.Server;

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

        // Surface token-usage just like a real model would on the final update, so the sample
        // works end-to-end without LLM credentials. The standard counts flow to the typed
        // RUN_FINISHED.usage field automatically; AdditionalCounts carries the provider-specific
        // entries that the typed field deliberately omits, which is what the RawEvent is for.
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            ModelId = "fake-model",
            Contents =
            [
                new UsageContent(new UsageDetails
                {
                    InputTokenCount = 9,
                    OutputTokenCount = 12,
                    TotalTokenCount = 21,
                    AdditionalCounts = new() { ["OutputTokenDetails.AcceptedPredictionTokenCount"] = 3 },
                }),
            ],
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
