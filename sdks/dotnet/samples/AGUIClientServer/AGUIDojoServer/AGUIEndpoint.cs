using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Samples.Shared;
using AGUI.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace AGUIDojoServer;

internal static class AGUIEndpoint
{
    internal static IEndpointConventionBuilder MapDojoEndpoint(
        this IEndpointRouteBuilder endpoints,
        string pattern,
        IChatClient chatClient,
        IList<AITool>? serverTools = null,
        string? systemPrompt = null,
        Func<JsonSerializerOptions, AGUIStreamOptions>? configureStreamOptions = null)
    {
        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            var jsonSerializerOptions = jsonOptions.Value.SerializerOptions;

            var streamOptions = configureStreamOptions?.Invoke(jsonSerializerOptions)
                ?? new AGUIStreamOptions();

            var ctx = input.ToChatRequestContext(jsonSerializerOptions, streamOptions);

            // Inject system prompt if provided
            if (systemPrompt is not null)
            {
                ctx.Messages.Insert(0, new ChatMessage(ChatRole.System, systemPrompt));
            }

            // Add server tools alongside any approval-wrapped client tools already
            // installed by ToChatRequestContext.
            if (serverTools is { Count: > 0 })
            {
                ctx.ChatOptions.Tools ??= [];
                foreach (var tool in serverTools)
                {
                    ctx.ChatOptions.Tools.Add(tool);
                }
            }

            var updates = chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, cancellationToken);

            var events = updates.AsAGUIEventStreamAsync(ctx, cancellationToken);

            return AGUIResults.Events(events, httpContext, cancellationToken);
        });
    }
}
