using AGUI.Samples.Shared;
using AGUI.Server;
using Microsoft.Extensions.AI;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Step14_Telemetry.Server;

public sealed class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.Services.AddAGUI();

        // Backend tools execute on the server. delete_file is wrapped with
        // ApprovalRequiredAIFunction so it pauses the run for human approval (the HITL scenario).
        var getWeather = AIFunctionFactory.Create(GetWeather, "get_weather", "Gets the current weather for a city.");
        var deleteFile = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create((string path) => $"deleted {path}", "delete_file", "Deletes a file."));

        builder.Services.AddSingleton<FakeChatClient>();
        builder.Services.AddChatClient(sp => sp.GetRequiredService<FakeChatClient>())
            .ConfigureOptions(o =>
            {
                o.Tools ??= [];
                o.Tools.Add(getWeather);
                o.Tools.Add(deleteFile);
            })
            .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true)
            .UseOpenTelemetry();

        // Export the AG-UI run spans, the Microsoft.Extensions.AI GenAI spans, and ASP.NET
        // request spans. The console exporter keeps the sample self-contained; set
        // OTEL_EXPORTER_OTLP_ENDPOINT (e.g. the Aspire dashboard or an OpenTelemetry Collector)
        // to switch to OTLP.
        var useOtlp = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT"));
        builder.Services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService("agui-telemetry-server"))
            .WithTracing(tracing =>
            {
                tracing
                    .AddSource(AGUIServerInstrumentation.ActivitySourceName)
                    .AddSource("Experimental.Microsoft.Extensions.AI")
                    .AddAspNetCoreInstrumentation();

                if (useOtlp)
                {
                    tracing.AddOtlpExporter();
                }
                else
                {
                    tracing.AddConsoleExporter();
                }
            });

        var app = builder.Build();

        app.MapAGUI("/");

        app.Run();
    }

    private static string GetWeather(string city) => $"Sunny, 22\u00B0C in {city}.";
}
