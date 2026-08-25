using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server.IntegrationTests;

internal sealed class CapturingChatClient : IChatClient
{
    private IChatClient? _inner;
    private readonly List<ServerCallCapture> _calls = new();

    internal IReadOnlyList<ServerCallCapture> Calls => _calls;

    internal void SetInner(IChatClient inner)
    {
        _inner = inner;
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var messagesList = messages.ToList();
        var updates = new List<ChatResponseUpdate>();

        // Extract the RunAgentInput that the server endpoint deserialized
        RunAgentInput? runAgentInput = null;
        options?.TryGetRunAgentInput(out runAgentInput);

        await foreach (var update in _inner!.GetStreamingResponseAsync(messagesList, options, cancellationToken).ConfigureAwait(false))
        {
            updates.Add(update);
            yield return update;
        }

        _calls.Add(new ServerCallCapture(runAgentInput, messagesList, options, updates));
    }

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return GetStreamingResponseAsync(messages, options, cancellationToken)
            .ToChatResponseAsync(cancellationToken);
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        return _inner?.GetService(serviceType, serviceKey);
    }

    public void Dispose()
    {
    }
}
