using System.ComponentModel;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace CrossLanguage.TestServer;

internal static class BackendToolRenderingRoute
{
    // Mirrors the dojo "backend_tool_rendering" backend. The LLM is given a
    // single get_weather server-side tool; the dojo aimock fixture replies
    // with a tool_call and the assistant streams back a rendered response.
    public static IEndpointConventionBuilder MapBackendToolRendering(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (
            [FromBody] RunAgentInput input,
            [FromServices] IChatClient chatClient,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            CancellationToken cancellationToken) =>
        {
            var jsonSerializerOptions = jsonOptions.Value.SerializerOptions;

            var ctx = input.ToChatRequestContext(jsonSerializerOptions);

            // Prepend the server-side weather tool. Client tools are already installed on
            // ctx.ChatOptions.Tools by ToChatRequestContext (with approval-flow wrapping if needed).
            ctx.ChatOptions.Tools ??= new List<AITool>();
            ctx.ChatOptions.Tools.Insert(0, AIFunctionFactory.Create(
                GetWeather,
                name: "get_weather",
                description: "Get the weather for a given location.",
                jsonSerializerOptions));

            IAsyncEnumerable<ChatResponseUpdate> updates =
                chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, cancellationToken);

            IAsyncEnumerable<BaseEvent> events = updates.AsAGUIEventStreamAsync(ctx, cancellationToken);

            return TypedResults.ServerSentEvents(AgenticChatRoute.WrapAsSseItems(events, cancellationToken));
        });
    }

    [Description("Get the weather for a given location.")]
    private static WeatherReport GetWeather(
        [Description("The location to get the weather for.")] string location) =>
        new()
        {
            Location = location,
            Temperature = 72,
            Conditions = "sunny",
            Humidity = 50,
            WindSpeed = 10,
            FeelsLike = 70,
        };
}

internal sealed class WeatherReport
{
    public string Location { get; init; } = string.Empty;
    public int Temperature { get; init; }
    public string Conditions { get; init; } = string.Empty;
    public int Humidity { get; init; }
    public int WindSpeed { get; init; }
    public int FeelsLike { get; init; }
}
