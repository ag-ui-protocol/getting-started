using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Samples.Shared;
using AGUI.Server;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace AGUI.Server.IntegrationTests;

internal static class AGUIEndpointExtensions
{
    internal static IEndpointConventionBuilder MapAGUI(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (RunAgentInput input, HttpContext httpContext) =>
        {
            var jsonOptions = httpContext.RequestServices.GetRequiredService<IOptions<JsonOptions>>();
            var jsonSerializerOptions = jsonOptions.Value.SerializerOptions;
            var cancellationToken = httpContext.RequestAborted;

            var chatClient = httpContext.RequestServices.GetRequiredService<IChatClient>();

            var ctx = input.ToChatRequestContext(jsonSerializerOptions);

            // Add server tools registered in DI alongside any approval-wrapped client tools
            // already installed by ToChatRequestContext.
            foreach (var tool in httpContext.RequestServices.GetServices<AITool>())
            {
                ctx.ChatOptions.Tools ??= new List<AITool>();
                ctx.ChatOptions.Tools.Add(tool);
            }

            var events = chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, cancellationToken)
                .AsAGUIEventStreamAsync(ctx, cancellationToken);

            // Negotiate the response transport (protobuf vs SSE) from the request Accept header.
            // The decoded BaseEvent stream is identical regardless of the negotiated encoding, so
            // all client-side capture points (and the Verify baselines) stay format-independent.
            return AGUIResults.Events(events, httpContext, cancellationToken);
        });
    }
}
