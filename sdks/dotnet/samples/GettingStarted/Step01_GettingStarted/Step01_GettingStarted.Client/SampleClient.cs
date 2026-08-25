using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step01_GettingStarted.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        // Turn 1: greet
        var messages = new List<ChatMessage> { new(ChatRole.User, "Hello") };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> Hello").ConfigureAwait(false);
        var turn1 = await StreamAsync(chatClient, messages, output, cancellationToken).ConfigureAwait(false);
        updatesPerTurn?.Add(turn1);

        // Carry the assistant reply into turn 2.
        messages.AddMessages(turn1.ToChatResponse());

        // Turn 2: follow up
        messages.Add(new ChatMessage(ChatRole.User, "How are you?"));
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> How are you?").ConfigureAwait(false);
        var turn2 = await StreamAsync(chatClient, messages, output, cancellationToken).ConfigureAwait(false);
        updatesPerTurn?.Add(turn2);
    }

    private static async Task<List<ChatResponseUpdate>> StreamAsync(
        IChatClient chatClient,
        IList<ChatMessage> messages,
        TextWriter output,
        CancellationToken cancellationToken)
    {
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
        return updates;
    }
}
