using System.Diagnostics;
using AGUI.Client;
using Microsoft.Extensions.AI;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Step14_Telemetry.Client;

public static class Program
{
    internal static readonly ActivitySource ActivitySource = new("Step14.Telemetry.Client");

    public static async Task Main(string[] args)
    {
        var baseUrl = args.Length > 0 ? args[0] : "http://localhost:5014";

        // Export the client HTTP spans and the conversation span. Console by default; set
        // OTEL_EXPORTER_OTLP_ENDPOINT to send to the Aspire dashboard or an OpenTelemetry
        // Collector instead. The exporter target should match the server's.
        var useOtlp = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT"));
        var tracing = Sdk.CreateTracerProviderBuilder()
            .ConfigureResource(resource => resource.AddService("agui-telemetry-client"))
            .AddSource(ActivitySource.Name)
            .AddSource("Experimental.AGUI.Client")
            .AddSource("Experimental.Microsoft.Extensions.AI")
            .AddHttpClientInstrumentation();
        tracing = useOtlp ? tracing.AddOtlpExporter() : tracing.AddConsoleExporter();
        using var tracerProvider = tracing.Build();

        using var httpClient = new HttpClient { BaseAddress = new Uri(baseUrl) };

        // Wrap the AG-UI client with UseOpenTelemetry so the client side also emits a GenAI
        // `chat` span (the parent of the outgoing HTTP request) — symmetric with the server.
        IChatClient aguiClient = new AGUIChatClient(new(httpClient, baseUrl))
            .AsBuilder()
            .UseOpenTelemetry()
            .Build();

        // One client-side activity spans the whole conversation, so the client's HTTP spans and
        // the server's run spans share a single trace: the W3C traceparent header flows over the
        // request and the server continues the trace.
        using var conversation = ActivitySource.StartActivity("agent conversation");
        await SampleClient.RunAsync(aguiClient, Console.Out).ConfigureAwait(false);
    }
}
