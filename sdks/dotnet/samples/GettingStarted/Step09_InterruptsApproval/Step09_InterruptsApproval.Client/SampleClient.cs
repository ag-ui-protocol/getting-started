using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step09_InterruptsApproval.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        // Turn 1: ask for the destructive action; expect a ToolApprovalRequestContent in reply.
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Please delete the file report-draft.txt"),
        };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> Please delete the file report-draft.txt").ConfigureAwait(false);

        var turn1 = await StreamAsync(chatClient, messages, output, cancellationToken).ConfigureAwait(false);
        updatesPerTurn?.Add(turn1);

        var approvalRequest = turn1
            .SelectMany(u => u.Contents)
            .OfType<ToolApprovalRequestContent>()
            .FirstOrDefault();

        if (approvalRequest is null)
        {
            return;
        }

        // Turn 2: approve and resume.
        var turn2Messages = new List<ChatMessage>(messages)
        {
            new(ChatRole.Assistant, [approvalRequest]),
            new(ChatRole.User, [approvalRequest.CreateResponse(approved: true)]),
        };
        messagesPerTurn?.Add(turn2Messages.ToList());
        await output.WriteLineAsync("> [approved]").ConfigureAwait(false);

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
                    case ToolApprovalRequestContent { ToolCall: FunctionCallContent fcc }:
                        await output.WriteLineAsync(
                            $"[approval requested] {fcc.Name}({string.Join(", ", fcc.Arguments?.Select(kv => $"{kv.Key}={kv.Value}") ?? [])})").ConfigureAwait(false);
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
