using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Samples.Shared;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace CrossLanguage.TestServer;

// Token usage over both wire transports. Deliberately does NOT go through the
// LLM: @copilotkit/aimock cannot emit usage on the streaming path (its SSEChunk
// type has no `usage` field and it does not honour `stream_options.include_usage`),
// so a fixture-driven route would silently assert nothing. Emitting UsageContent
// directly keeps the assertion meaningful and deterministic.
//
// What this route proves that the codec unit tests cannot: usage survives real
// HTTP transport negotiation and the .NET protobuf *server* encoder, decoded by
// the real TypeScript client.
internal static class TokenUsageRoute
{
    private const string ModelId = "usage-model";

    public static IEndpointConventionBuilder MapTokenUsage(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            var jsonSerializerOptions = jsonOptions.Value.SerializerOptions;

            // Declare the provider label the same way a real endpoint would.
            var streamOptions = new AGUIStreamOptions().WithUsageProvider("usage-provider");
            var ctx = input.ToChatRequestContext(jsonSerializerOptions, streamOptions);

            IAsyncEnumerable<BaseEvent> events =
                UsageUpdates(cancellationToken).AsAGUIEventStreamAsync(ctx, cancellationToken);

            return AGUIResults.Events(events, httpContext, cancellationToken);
        });
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> UsageUpdates(
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "usage demo")
        {
            MessageId = "usage-msg-1",
            ModelId = ModelId,
        };

        // Two usage reports for the same model, so the assertion also covers
        // per-(provider, model) accumulation across updates rather than a single
        // pass-through. A zero is included so "reported 0" is exercised over the
        // wire alongside the omitted counts.
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            ModelId = ModelId,
            Contents =
            [
                new UsageContent(new UsageDetails
                {
                    InputTokenCount = 10,
                    OutputTokenCount = 4,
                    CachedInputTokenCount = 0,
                })
            ],
        };

        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            ModelId = ModelId,
            Contents =
            [
                new UsageContent(new UsageDetails
                {
                    InputTokenCount = 5,
                    OutputTokenCount = 3,
                    ReasoningTokenCount = 2,
                })
            ],
        };

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
