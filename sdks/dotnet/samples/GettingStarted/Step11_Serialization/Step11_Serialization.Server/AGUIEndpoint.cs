using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Samples.Shared;
using AGUI.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Step11_Serialization.Server;

internal static class AGUIEndpoint
{
    internal static IEndpointConventionBuilder MapAGUIWithHistory(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            [FromServices] IChatClient chatClient,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            [FromServices] MessageHistoryStore historyStore,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            var jsonSerializerOptions = jsonOptions.Value.SerializerOptions;
            var ctx = input.ToChatRequestContext(jsonSerializerOptions);

            // If parentRunId is provided, look up previous messages and combine
            List<ChatMessage> chatMessages;
            if (!string.IsNullOrEmpty(input.ParentRunId))
            {
                var previousMessages = historyStore.GetMessages(input.ThreadId);
                chatMessages = [.. previousMessages, .. ctx.Messages];
            }
            else
            {
                chatMessages = ctx.Messages;
            }

            var events = chatClient.GetStreamingResponseAsync(chatMessages, ctx.ChatOptions, cancellationToken)
                .AsAGUIEventStreamAsync(ctx, cancellationToken);

            // Capture and store the assistant response in history, then negotiate the
            // response transport (SSE or protobuf) via the shared AGUIResults helper.
            return AGUIResults.Events(
                WrapAndStoreHistory(events, historyStore, input.ThreadId, chatMessages, cancellationToken),
                httpContext,
                cancellationToken);
        });
    }

    private static async IAsyncEnumerable<BaseEvent> WrapAndStoreHistory(
        IAsyncEnumerable<BaseEvent> events,
        MessageHistoryStore historyStore,
        string threadId,
        List<ChatMessage> chatMessages,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? assistantText = null;

        await foreach (var evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            if (evt is TextMessageContentEvent textContent)
            {
                assistantText = (assistantText ?? "") + textContent.Delta;
            }

            yield return evt;
        }

        // After streaming completes, store the full conversation (including assistant reply) for this thread
        if (assistantText is not null)
        {
            chatMessages.Add(new ChatMessage(ChatRole.Assistant, assistantText));
        }

        historyStore.StoreMessages(threadId, chatMessages);
    }
}

internal sealed class MessageHistoryStore
{
    private readonly ConcurrentDictionary<string, List<ChatMessage>> _store = new();

    public List<ChatMessage> GetMessages(string threadId)
    {
        return _store.TryGetValue(threadId, out var messages) ? messages : [];
    }

    public void StoreMessages(string threadId, List<ChatMessage> messages)
    {
        _store[threadId] = [.. messages];
    }
}