using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Step10_InterruptsUserInput.Server;

/// <summary>
/// Deterministic stand-in for an LLM so the sample runs without credentials, and the replay
/// source for the integration test. When responses are enqueued they are replayed in order;
/// otherwise it falls back to calling the <c>request_user_input</c> tool on the first turn and
/// confirming the account once the tool result (the user's answer) is present.
/// </summary>
internal sealed class FakeChatClient : IChatClient
{
    private readonly Queue<Func<IEnumerable<ChatMessage>, IAsyncEnumerable<ChatResponseUpdate>>> _handlers = new();

    internal void Enqueue(Func<IEnumerable<ChatMessage>, IAsyncEnumerable<ChatResponseUpdate>> handler)
    {
        _handlers.Enqueue(handler);
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

        var result = messages
            .SelectMany(m => m.Contents)
            .OfType<FunctionResultContent>()
            .FirstOrDefault(c => c.CallId.StartsWith("call_user_input", StringComparison.Ordinal));

        if (result is not null)
        {
            var username = result.Result?.ToString() ?? string.Empty;
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents = [new TextContent($"Thank you! Your account has been created with the username '{username}'.")],
                ModelId = "fake-model",
            };
            yield break;
        }

        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents =
            [
                new FunctionCallContent(
                    callId: "call_user_input_1",
                    name: UserInputToolChatClient.ToolName,
                    arguments: new Dictionary<string, object?> { ["prompt"] = "What username would you like for your account?" }),
            ],
            FinishReason = ChatFinishReason.ToolCalls,
            ModelId = "fake-model",
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return GetStreamingResponseAsync(messages, options, cancellationToken)
            .ToChatResponseAsync(cancellationToken);
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceType == typeof(IChatClient) ? this : null;

    public void Dispose()
    {
    }
}
