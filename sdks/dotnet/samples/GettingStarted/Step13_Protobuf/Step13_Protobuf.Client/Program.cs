using AGUI.Client;
using AGUI.Formatting;
using AGUI.Protobuf;

namespace Step13_Protobuf.Client;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var baseUrl = args.Length > 0 ? args[0] : "http://localhost:5013";

        // The AGUIEventStreamHandler advertises the formatters (in preference order) on the Accept
        // header and decodes whichever representation the server returns. Listing the protobuf
        // formatter first makes the client prefer protobuf; the server falls back to SSE if it does
        // not support protobuf. Swapping protobuf <-> SSE is purely a matter of changing this
        // formatter list - nothing downstream (SampleClient, AGUIChatClient) changes.
        var handler = new AGUIEventStreamHandler(
            [new ProtobufEventStreamFormatter(), new SseEventStreamFormatter()])
        {
            InnerHandler = new HttpClientHandler(),
        };

        using var httpClient = new HttpClient(handler);
        var aguiClient = new AGUIChatClient(new(httpClient, baseUrl));

        await SampleClient.RunAsync(aguiClient, Console.Out).ConfigureAwait(false);
    }
}
