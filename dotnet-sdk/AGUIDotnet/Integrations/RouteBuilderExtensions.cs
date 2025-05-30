using System;
using AGUIDotnet.Agent;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.AI;
using AGUIDotnet.Types;
using AGUIDotnet.Events;
using Microsoft.Extensions.Options;
using System.Text.Json;

namespace AGUIDotnet.Integrations;

public static class RouteBuilderExtensions
{
    /// <summary>
    /// Simple extension method to map an AGUI agent endpoint that uses server sent events to the provided route builder
    /// </summary>
    /// <param name="builder">The <see cref="IEndpointRouteBuilder"/> to map the POST endpoint to</param>
    /// <param name="id">The ID of the agent which also becomes the mapped endpoint pattern</param>
    /// <param name="agentFactory">Factory to resolve the agent instance</param>
    /// <returns>An <see cref="IEndpointConventionBuilder"/></returns>
    public static IEndpointConventionBuilder MapAgentEndpoint(
        this IEndpointRouteBuilder builder,
        string id,
        Func<IServiceProvider, IAGUIAgent> agentFactory
    )
    {
        return builder.MapPost(
            id,
            async (
                [FromBody] RunAgentInput input,
                HttpContext context,
                IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions> jsonOptions
            ) =>
            {
                context.Response.ContentType = "text/event-stream";
                await context.Response.Body.FlushAsync().ConfigureAwait(true);

                var serOptions = jsonOptions.Value.SerializerOptions;
                var agent = agentFactory(context.RequestServices);

                await foreach (var ev in agent.RunToCompletionAsync(input, context.RequestAborted).ConfigureAwait(true))
                {
                    var serializedEvent = JsonSerializer.Serialize(ev, serOptions);
                    await context.Response.WriteAsync($"data: {serializedEvent}\n\n").ConfigureAwait(true);
                    await context.Response.Body.FlushAsync().ConfigureAwait(true);

                    // If the event is a RunFinishedEvent, we can break the loop.
                    if (ev is RunFinishedEvent)
                    {
                        break;
                    }
                }
            }
        );
    }
}
