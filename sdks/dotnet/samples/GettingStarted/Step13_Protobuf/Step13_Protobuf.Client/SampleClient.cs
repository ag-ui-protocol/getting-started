using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step13_Protobuf.Client;

public static class SampleClient
{
    // The scenario is intentionally transport-agnostic: it streams a single user turn and
    // prints the assistant text. The same code works whether the negotiated wire format is
    // protobuf or Server-Sent Events.
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        CancellationToken cancellationToken = default)
    {
        var messages = new List<ChatMessage> { new(ChatRole.User, "Hello over protobuf!") };
        await output.WriteLineAsync("> Hello over protobuf!").ConfigureAwait(false);

        await foreach (var update in chatClient.GetStreamingResponseAsync(
            messages, options: null, cancellationToken).ConfigureAwait(false))
        {
            if (!string.IsNullOrEmpty(update.Text))
            {
                await output.WriteAsync(update.Text).ConfigureAwait(false);
            }
        }

        await output.WriteLineAsync().ConfigureAwait(false);
    }
}
