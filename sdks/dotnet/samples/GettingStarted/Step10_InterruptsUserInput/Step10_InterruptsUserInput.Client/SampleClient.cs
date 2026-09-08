using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step10_InterruptsUserInput.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        // Turn 1: ask to set up the account; the server pauses with an InterruptRequestContent.
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Please setup my account"),
        };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> Please setup my account").ConfigureAwait(false);

        var turn1 = await StreamAsync(chatClient, messages, output, cancellationToken).ConfigureAwait(false);
        updatesPerTurn?.Add(turn1);

        var interrupt = turn1
            .SelectMany(u => u.Contents)
            .OfType<InterruptRequestContent>()
            .FirstOrDefault();
        if (interrupt is null)
        {
            return;
        }

        // Turn 2: append the interrupt + an InterruptResponseContent. The AGUIChatClient
        // encodes the response as RunAgentInput.Resume[] on the wire.
        var responsePayload = JsonSerializer.SerializeToElement(new { response = "johndoe42" });
        var responseContent = new InterruptResponseContent(interrupt.RequestId) { Payload = responsePayload };

        var turn2Messages = new List<ChatMessage>(messages)
        {
            new(ChatRole.Assistant, [interrupt]),
            new(ChatRole.User, [responseContent]),
        };
        messagesPerTurn?.Add(turn2Messages.ToList());
        await output.WriteLineAsync("> [user input: johndoe42]").ConfigureAwait(false);

        var turn2 = await StreamAsync(chatClient, turn2Messages, output, cancellationToken).ConfigureAwait(false);
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

            foreach (var content in update.Contents)
            {
                switch (content)
                {
                    case InterruptRequestContent ireq:
                        await output.WriteLineAsync($"[interrupt: {ireq.Reason}] {ireq.Message}").ConfigureAwait(false);
                        break;
                    case TextContent { Text: { Length: > 0 } text }:
                        await output.WriteAsync(text).ConfigureAwait(false);
                        break;
                }
            }
        }
        await output.WriteLineAsync().ConfigureAwait(false);
        return updates;
    }
}
