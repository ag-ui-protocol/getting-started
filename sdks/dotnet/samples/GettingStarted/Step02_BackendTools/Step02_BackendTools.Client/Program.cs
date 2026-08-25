using AGUI.Client;

namespace Step02_BackendTools.Client;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var baseUrl = args.Length > 0 ? args[0] : "http://localhost:5002";

        using var httpClient = new HttpClient();
        var aguiClient = new AGUIChatClient(new(httpClient, baseUrl));

        await SampleClient.RunAsync(aguiClient, Console.Out).ConfigureAwait(false);
    }
}