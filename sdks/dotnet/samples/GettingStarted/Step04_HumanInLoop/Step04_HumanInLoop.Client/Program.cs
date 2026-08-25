using AGUI.Client;

namespace Step04_HumanInLoop.Client;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var baseUrl = args.Length > 0 ? args[0] : "http://localhost:5004";

        using var httpClient = new HttpClient();
        var aguiClient = new AGUIChatClient(new(httpClient, baseUrl));

        await SampleClient.RunAsync(aguiClient, Console.Out).ConfigureAwait(false);
    }
}