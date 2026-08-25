using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step14_Telemetry.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        CancellationToken cancellationToken = default)
    {
        // A client-side (frontend) tool the agent can call into the app to run.
        var location = AIFunctionFactory.Create(
            () => "Amsterdam, NL", "get_user_location", "Gets the user's current location.");

        // Scenario 1 - backend tool: get_weather runs on the server.
        using (Program.ActivitySource.StartActivity("scenario: backend tool"))
        {
            await output.WriteLineAsync("> What's the weather in Paris?").ConfigureAwait(false);
            await StreamAsync(chatClient, [new ChatMessage(ChatRole.User, "What's the weather in Paris?")], options: null, output, cancellationToken).ConfigureAwait(false);
        }

        // Scenario 2 - mixed tools: a backend tool (server) and a frontend tool (client) in one run.
        using (Program.ActivitySource.StartActivity("scenario: mixed tools"))
        {
            await output.WriteLineAsync("> What's fun to do near me?").ConfigureAwait(false);
            var options = new ChatOptions { Tools = [location] };
            await StreamAsync(chatClient, [new ChatMessage(ChatRole.User, "What's fun to do near me?")], options, output, cancellationToken).ConfigureAwait(false);
        }

        // Scenario 3 - human-in-the-loop: delete_file is approval-gated (interrupt then resume).
        using (Program.ActivitySource.StartActivity("scenario: human-in-the-loop"))
        {
            await output.WriteLineAsync("> Delete report-draft.txt").ConfigureAwait(false);
            var messages = new List<ChatMessage> { new(ChatRole.User, "Delete report-draft.txt") };
            var turn1 = await CollectAsync(chatClient, messages, options: null, output, cancellationToken).ConfigureAwait(false);

            var approval = turn1.SelectMany(u => u.Contents).OfType<ToolApprovalRequestContent>().FirstOrDefault();
            if (approval is not null)
            {
                await output.WriteLineAsync("> [approved]").ConfigureAwait(false);
                messages.Add(new ChatMessage(ChatRole.Assistant, [approval]));
                messages.Add(new ChatMessage(ChatRole.User, [approval.CreateResponse(approved: true)]));
                await StreamAsync(chatClient, messages, options: null, output, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private static async Task StreamAsync(
        IChatClient chatClient, IList<ChatMessage> messages, ChatOptions? options, TextWriter output, CancellationToken cancellationToken)
    {
        await foreach (var update in chatClient.GetStreamingResponseAsync(messages, options, cancellationToken).ConfigureAwait(false))
        {
            if (!string.IsNullOrEmpty(update.Text))
            {
                await output.WriteAsync(update.Text).ConfigureAwait(false);
            }
        }

        await output.WriteLineAsync().ConfigureAwait(false);
    }

    private static async Task<List<ChatResponseUpdate>> CollectAsync(
        IChatClient chatClient, IList<ChatMessage> messages, ChatOptions? options, TextWriter output, CancellationToken cancellationToken)
    {
        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in chatClient.GetStreamingResponseAsync(messages, options, cancellationToken).ConfigureAwait(false))
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
