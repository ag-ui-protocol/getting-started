using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Step13_Protobuf.Server;

internal sealed class FakeChatClient : IChatClient
{
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
        // Deterministic canned response so the sample is runnable end-to-end without
        // LLM credentials. The response shape is identical regardless of whether the
        // negotiated wire format is protobuf or SSE.
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
