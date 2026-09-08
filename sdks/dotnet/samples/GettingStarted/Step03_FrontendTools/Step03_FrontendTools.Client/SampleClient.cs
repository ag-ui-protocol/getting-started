using System.ComponentModel;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step03_FrontendTools.Client;

public static class SampleClient
{
    [Description("Get the user's current location from GPS.")]
    private static string GetUserLocation() =>
        "Amsterdam, Netherlands (52.37°N, 4.90°E)";

    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        AITool[] clientTools = [AIFunctionFactory.Create(GetUserLocation)];

        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "What are some fun things to do near me?"),
        };
        var options = new ChatOptions { Tools = clientTools.ToList<AITool>() };

        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> What are some fun things to do near me?").ConfigureAwait(false);

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in chatClient.GetStreamingResponseAsync(
            messages, options, cancellationToken).ConfigureAwait(false))
        {
            updates.Add(update);
            if (!string.IsNullOrEmpty(update.Text))
            {
                await output.WriteAsync(update.Text).ConfigureAwait(false);
            }
        }
        await output.WriteLineAsync().ConfigureAwait(false);
        updatesPerTurn?.Add(updates);
    }
}
