using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step12_ParallelToolCalls.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        const string prompt = "What's the weather in Paris and the current time in Tokyo?";

        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, prompt),
        };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync($"> {prompt}").ConfigureAwait(false);

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in chatClient.GetStreamingResponseAsync(
            messages, options: null, cancellationToken).ConfigureAwait(false))
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
