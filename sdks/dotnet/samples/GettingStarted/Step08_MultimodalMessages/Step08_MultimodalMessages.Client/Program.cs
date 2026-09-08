using AGUI.Client;

namespace Step08_MultimodalMessages.Client;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var baseUrl = args.Length > 0 ? args[0] : "http://localhost:5008";

        using var httpClient = new HttpClient();
        var aguiClient = new AGUIChatClient(new(httpClient, baseUrl));

        // If a PNG path is passed as the second arg, load it; otherwise SampleClient
        // falls back to a built-in 1×1 placeholder so the sample is always runnable.
        byte[]? imageBytes = args.Length > 1 && File.Exists(args[1])
            ? await File.ReadAllBytesAsync(args[1]).ConfigureAwait(false)
            : null;

        await SampleClient.RunAsync(aguiClient, Console.Out, imageBytes).ConfigureAwait(false);
    }
}
