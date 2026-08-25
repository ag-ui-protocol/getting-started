using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step11_Serialization.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        // Turn 1: introductory question.
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Hello, tell me about serialization"),
        };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> Hello, tell me about serialization").ConfigureAwait(false);

        var turn1 = await StreamAsync(chatClient, messages, options: null, output, cancellationToken).ConfigureAwait(false);
        updatesPerTurn?.Add(turn1);

        // Turn 2: branch from the previous run by setting RunAgentInput.ThreadId and
        // ParentRunId through ChatOptions.RawRepresentationFactory — the AG-UI-native way
        // to set wire-level fields. AGUIChatClient is stateless and never surfaces a
        // ConversationId (a stateless client must not advertise one), so the thread/run ids
        // are read from the RUN_STARTED event's raw representation instead.
        var runStarted = turn1
            .Select(u => u.RawRepresentation)
            .OfType<RunStartedEvent>()
            .FirstOrDefault();
        var threadId = runStarted?.ThreadId;
        var parentRunId = runStarted?.RunId;

        var followUp = new List<ChatMessage>
        {
            new(ChatRole.User, "Tell me more about event compaction"),
        };
        var followUpOptions = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                ThreadId = threadId ?? string.Empty,
                ParentRunId = parentRunId,
            },
        };
        messagesPerTurn?.Add(followUp.ToList());
        await output.WriteLineAsync("> Tell me more about event compaction").ConfigureAwait(false);

        var turn2 = await StreamAsync(chatClient, followUp, followUpOptions, output, cancellationToken).ConfigureAwait(false);
        updatesPerTurn?.Add(turn2);
    }

    private static async Task<List<ChatResponseUpdate>> StreamAsync(
        IChatClient chatClient,
        IList<ChatMessage> messages,
        ChatOptions? options,
        TextWriter output,
        CancellationToken cancellationToken)
    {
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
        return updates;
    }
}
