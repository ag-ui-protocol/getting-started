using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step05_StateManagement.Client;

public static class SampleClient
{
    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        // Send an empty-recipe state along with the user message so the server's
        // RecipeStateChatClient enters state-management mode.
        var initialState = new
        {
            recipe = new
            {
                title = "",
                cuisine = "",
                ingredients = Array.Empty<string>(),
                steps = Array.Empty<string>(),
                prep_time_minutes = 0,
                cook_time_minutes = 0,
                skill_level = "",
            },
        };

        var stateJson = JsonSerializer.SerializeToElement(initialState);

        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Suggest me an Italian pasta recipe"),
        };
        var options = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput { State = stateJson },
        };

        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync("> Suggest me an Italian pasta recipe").ConfigureAwait(false);

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
