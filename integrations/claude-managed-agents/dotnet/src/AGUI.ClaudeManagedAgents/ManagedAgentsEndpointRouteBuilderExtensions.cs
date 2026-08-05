using System.Text.Json;
using AGUI.Abstractions;
using AGUI.ClaudeManagedAgents;
using AGUI.Formatting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;

namespace Microsoft.AspNetCore.Builder;

/// <summary>
/// Endpoint routing extensions that expose a <see cref="ManagedAgentsAgent"/> over HTTP as an
/// AG-UI Server-Sent Events endpoint.
/// </summary>
public static class ManagedAgentsEndpointRouteBuilderExtensions
{
    private static readonly SseEventStreamFormatter s_formatter = new();

    /// <summary>
    /// Maps a <c>POST</c> endpoint at <paramref name="pattern"/> that runs one turn of
    /// <paramref name="agent"/> for the posted <see cref="RunAgentInput"/> and streams the
    /// resulting AG-UI events as Server-Sent Events.
    /// </summary>
    /// <param name="endpoints">The endpoint route builder.</param>
    /// <param name="pattern">The route pattern to map.</param>
    /// <param name="agent">The managed-agents agent that serves the route.</param>
    /// <returns>An <see cref="IEndpointConventionBuilder"/> for further endpoint configuration.</returns>
    public static IEndpointConventionBuilder MapManagedAgentsAgent(
        this IEndpointRouteBuilder endpoints,
        string pattern,
        ManagedAgentsAgent agent)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(pattern);
        ArgumentNullException.ThrowIfNull(agent);

        return endpoints.MapPost(pattern, async httpContext =>
        {
            var cancellationToken = httpContext.RequestAborted;

            RunAgentInput? input;
            try
            {
                input = await JsonSerializer
                    .DeserializeAsync(httpContext.Request.Body, AGUIJsonSerializerContext.Default.RunAgentInput, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (JsonException)
            {
                input = null;
            }

            var response = httpContext.Response;
            if (input is null)
            {
                response.StatusCode = StatusCodes.Status400BadRequest;
                response.ContentType = "application/json";
                await response.WriteAsync("{\"error\":\"Invalid JSON body\"}", cancellationToken).ConfigureAwait(false);
                return;
            }

            response.StatusCode = StatusCodes.Status200OK;
            response.ContentType = SseEventStreamFormatter.ServerSentEventsMediaType;
            response.Headers.CacheControl = "no-cache";
            httpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            var events = agent.RunAsync(input, cancellationToken);
            await s_formatter.WriteAsync(events, response.Body, cancellationToken).ConfigureAwait(false);
            await response.Body.FlushAsync(cancellationToken).ConfigureAwait(false);
        });
    }
}
