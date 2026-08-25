using System.ComponentModel;
using System.Globalization;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace CrossLanguage.TestServer;

internal static class ParallelToolCallsRoute
{
    // Two independent server-side tools (get_weather + get_current_time). A single
    // prompt elicits BOTH tool calls in one assistant turn; FunctionInvokingChatClient
    // resolves both server-side and the LLM is re-invoked with both tool results. This
    // exercises the parallel-tool-result conversion path across the language boundary.
    public static IEndpointConventionBuilder MapParallelToolCalls(
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

            ctx.ChatOptions.Tools ??= new List<AITool>();
            ctx.ChatOptions.Tools.Insert(0, AIFunctionFactory.Create(
                GetWeather,
                name: "get_weather",
                description: "Gets the current weather for a given city.",
                jsonSerializerOptions));
            ctx.ChatOptions.Tools.Insert(1, AIFunctionFactory.Create(
                GetCurrentTime,
                name: "get_current_time",
                description: "Gets the current local time for a given IANA timezone.",
                jsonSerializerOptions));

            IAsyncEnumerable<ChatResponseUpdate> updates =
                chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, cancellationToken);

            IAsyncEnumerable<BaseEvent> events = updates.AsAGUIEventStreamAsync(ctx, cancellationToken);

            return TypedResults.ServerSentEvents(AgenticChatRoute.WrapAsSseItems(events, cancellationToken));
        });
    }

    [Description("Gets the current weather for a given city.")]
    private static WeatherReport GetWeather(
        [Description("The city to get the weather for.")] string city) =>
        new()
        {
            Location = city,
            Temperature = 72,
            Conditions = "sunny",
            Humidity = 50,
            WindSpeed = 10,
            FeelsLike = 70,
        };

    [Description("Gets the current local time for a given IANA timezone.")]
    private static TimeReport GetCurrentTime(
        [Description("The IANA timezone name, e.g. 'Asia/Tokyo'.")] string timezone) =>
        new()
        {
            Timezone = timezone,
            // Deterministic fixed clock keeps the scenario replayable without a real time source.
            CurrentTime = new DateTimeOffset(2026, 6, 18, 9, 30, 0, TimeSpan.Zero)
                .ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture),
        };
}

internal sealed class TimeReport
{
    public string Timezone { get; init; } = string.Empty;
    public string CurrentTime { get; init; } = string.Empty;
}
