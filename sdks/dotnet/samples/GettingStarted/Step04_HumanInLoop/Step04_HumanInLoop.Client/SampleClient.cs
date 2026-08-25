using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step04_HumanInLoop.Client;

public static class SampleClient
{
    private static readonly JsonSerializerOptions s_jsonOptions = CreateJsonOptions();

    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        // Wrap the AG-UI client with the symmetric approval wrapper so calling code
        // sees standard MEAI ToolApprovalRequestContent / ToolApprovalResponseContent.
        using var wrapped = new ApprovalAGUIChatClient(chatClient, s_jsonOptions);

        // Turn 1: ask for the approval-required action.
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Please approve expense report EXP-2024-001"),
        };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> Please approve expense report EXP-2024-001").ConfigureAwait(false);

        var turn1 = await StreamAsync(wrapped, messages, output, cancellationToken).ConfigureAwait(false);
        updatesPerTurn?.Add(turn1);

        // The server-side wrapper produced a ToolApprovalRequestContent; if we got one,
        // resume with an approval response on a second turn.
        var approvalRequest = turn1
            .SelectMany(u => u.Contents)
            .OfType<ToolApprovalRequestContent>()
            .FirstOrDefault();

        if (approvalRequest is null)
        {
            return;
        }

        var turn2Messages = new List<ChatMessage>(messages)
        {
            new(ChatRole.Assistant, [approvalRequest]),
            new(ChatRole.User, [approvalRequest.CreateResponse(approved: true)]),
        };
        messagesPerTurn?.Add(turn2Messages.ToList());
        await output.WriteLineAsync("> [approved]").ConfigureAwait(false);

        var turn2 = await StreamAsync(wrapped, turn2Messages, output, cancellationToken).ConfigureAwait(false);
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

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        options.TypeInfoResolverChain.Add(AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
        options.TypeInfoResolverChain.Add(SampleJsonSerializerContext.Default);
        return options;
    }
}
