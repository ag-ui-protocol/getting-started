// Test-only helper. The AG-UI specification does not describe how an agent's capabilities are
// exposed over the wire, so this helper deliberately lives in the test project rather than the
// product. Consumers should expose capabilities however suits their deployment (a static file, a
// discovery endpoint of their own design, an OpenAPI document, etc.).

using System;
using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace AGUI.Server.IntegrationTests;

internal static class AGUICapabilitiesEndpointRouteBuilderExtensions
{
    public static IEndpointConventionBuilder MapAGUICapabilities(
        this IEndpointRouteBuilder endpoints,
        [StringSyntax("Route")] string pattern,
        AgentCapabilities capabilities)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(capabilities);

        return endpoints.Map(pattern, async context =>
        {
            if (!HttpMethods.IsGet(context.Request.Method))
            {
                context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
                return;
            }

            context.Response.ContentType = "application/json";
            await JsonSerializer.SerializeAsync(
                context.Response.Body,
                capabilities,
                AGUIJsonSerializerContext.Default.AgentCapabilities,
                context.RequestAborted).ConfigureAwait(false);
        });
    }

    public static IEndpointConventionBuilder MapAGUICapabilities(
        this IEndpointRouteBuilder endpoints,
        [StringSyntax("Route")] string pattern,
        Func<AgentCapabilities> capabilitiesFactory)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(capabilitiesFactory);

        return endpoints.Map(pattern, async context =>
        {
            if (!HttpMethods.IsGet(context.Request.Method))
            {
                context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
                return;
            }

            var capabilities = capabilitiesFactory();
            context.Response.ContentType = "application/json";
            await JsonSerializer.SerializeAsync(
                context.Response.Body,
                capabilities,
                AGUIJsonSerializerContext.Default.AgentCapabilities,
                context.RequestAborted).ConfigureAwait(false);
        });
    }
}
