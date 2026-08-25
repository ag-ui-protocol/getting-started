using Microsoft.Extensions.AI;

namespace AGUI.Server.IntegrationTests;

internal sealed class DelegatingStreamingChatClient : IChatClient
{
    private Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>>? _handler;

    internal void SetHandler(Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> handler)
    {
        _handler = handler;
    }

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        if (_handler == null)
        {
            throw new InvalidOperationException("No handler configured on DelegatingStreamingChatClient.");
        }

        return _handler(messages, options, cancellationToken);
    }

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        throw new NotSupportedException("Only streaming is supported in tests.");
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        if (serviceType == typeof(IChatClient))
        {
            return this;
        }

        return null;
    }

    public void Dispose()
    {
    }
}
