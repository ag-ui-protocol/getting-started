using AGUI.Samples.Shared;
using System.ComponentModel;
using System.Globalization;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace Step12_ParallelToolCalls.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.TypeInfoResolverChain.Add(SampleJsonSerializerContext.Default));

        var getWeather = AIFunctionFactory.Create(
            GetWeather,
            name: "get_weather",
            description: "Gets the current weather for a given city.",
            serializerOptions: SampleJsonSerializerContext.Default.Options);

        var getCurrentTime = AIFunctionFactory.Create(
            GetCurrentTime,
            name: "get_current_time",
            description: "Gets the current local time for a given IANA timezone.",
            serializerOptions: SampleJsonSerializerContext.Default.Options);

        if (string.Equals(builder.Configuration["UseAzureOpenAI"], "true", StringComparison.OrdinalIgnoreCase))
        {
            var endpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT is not set.");
            var deploymentName = builder.Configuration["AZURE_OPENAI_DEPLOYMENT_NAME"]
                ?? throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT_NAME is not set.");

            builder.Services.AddChatClient(new AzureOpenAIClient(
                    new Uri(endpoint),
                    new DefaultAzureCredential())
                .GetChatClient(deploymentName)
                .AsIChatClient())
                .ConfigureOptions(options =>
                {
                    options.Tools ??= [];
                    options.Tools.Add(getWeather);
                    options.Tools.Add(getCurrentTime);
                })
                // AllowConcurrentInvocation lets FunctionInvokingChatClient execute the two
                // parallel backend tool calls concurrently. Parallel tool calls are enabled on
                // the OpenAI side by default, so the model surfaces both calls in one assistant turn.
                .UseFunctionInvocation(configure: fic =>
                {
                    fic.TerminateOnUnknownCalls = true;
                    fic.AllowConcurrentInvocation = true;
                });
        }
        else
        {
            builder.Services.AddSingleton<FakeChatClient>();
            builder.Services.AddChatClient(sp => sp.GetRequiredService<FakeChatClient>())
                .ConfigureOptions(options =>
                {
                    options.Tools ??= [];
                    options.Tools.Add(getWeather);
                    options.Tools.Add(getCurrentTime);
                })
                .UseFunctionInvocation(configure: fic =>
                {
                    fic.TerminateOnUnknownCalls = true;
                    fic.AllowConcurrentInvocation = true;
                });
        }

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }

    [Description("Gets the current weather for a given city.")]
    private static WeatherReport GetWeather(
        [Description("The city to get the weather for.")] string city)
    {
        return new WeatherReport
        {
            City = city,
            Conditions = "sunny",
            TemperatureCelsius = 22,
        };
    }

    [Description("Gets the current local time for a given IANA timezone.")]
    private static TimeReport GetCurrentTime(
        [Description("The IANA timezone name, e.g. 'Asia/Tokyo'.")] string timezone)
    {
        // Deterministic fixed clock keeps the sample replayable without a real time source.
        return new TimeReport
        {
            Timezone = timezone,
            CurrentTime = new DateTimeOffset(2026, 6, 18, 9, 30, 0, TimeSpan.Zero)
                .ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture),
        };
    }
}
