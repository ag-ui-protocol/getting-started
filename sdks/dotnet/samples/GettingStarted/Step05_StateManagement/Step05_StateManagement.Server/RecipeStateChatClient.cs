using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Extensions.AI;

namespace Step05_StateManagement.Server;

/// <summary>
/// A stateless <see cref="DelegatingChatClient"/> that implements the recipe
/// state-management flow. When the originating AG-UI <see cref="RunAgentInput"/> carries
/// a non-empty <see cref="RunAgentInput.State"/>, the client issues two LLM calls:
/// one that produces a structured <see cref="AgentState"/> (emitted as a
/// <see cref="StateSnapshotEvent"/> via <see cref="ChatResponseUpdate.RawRepresentation"/>),
/// and one that produces a user-friendly summary. Otherwise the request is passed through
/// to the inner client unchanged.
/// </summary>
internal sealed class RecipeStateChatClient : DelegatingChatClient
{
    private const string RecipeInstructions = """
        You are a helpful recipe assistant. When users ask you to create or suggest a recipe,
        respond with a complete JSON object that includes:
        - recipe.title: The recipe name
        - recipe.cuisine: Type of cuisine (e.g., Italian, Mexican, Japanese)
        - recipe.ingredients: Array of ingredient strings with quantities
        - recipe.steps: Array of cooking instruction strings
        - recipe.prep_time_minutes: Preparation time in minutes
        - recipe.cook_time_minutes: Cooking time in minutes
        - recipe.skill_level: One of "beginner", "intermediate", or "advanced"

        Always include all fields in the response. Be creative and helpful.
        """;

    private readonly JsonSerializerOptions _jsonSerializerOptions;

    public RecipeStateChatClient(IChatClient innerClient, JsonSerializerOptions jsonSerializerOptions)
        : base(innerClient)
    {
        _jsonSerializerOptions = jsonSerializerOptions;
    }

    public override IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        if (options is not null
            && options.TryGetRunAgentInput(out var input)
            && input.State is { ValueKind: JsonValueKind.Object } state
            && HasProperties(state))
        {
            return GetStreamingStateResponseAsync(messages, options, input, cancellationToken);
        }

        return base.GetStreamingResponseAsync(messages, options, cancellationToken);
    }

    private async IAsyncEnumerable<ChatResponseUpdate> GetStreamingStateResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions options,
        RunAgentInput input,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        // First LLM call: generate structured state using a JSON schema response format.
        var stateOptions = new ChatOptions
        {
            ResponseFormat = ChatResponseFormat.ForJsonSchema<AgentState>(
                schemaName: "AgentState",
                schemaDescription: "A response containing a recipe with title, skill level, cooking time, ingredients, and instructions")
        };

        var stateMessages = new List<ChatMessage>(messages)
        {
            new(ChatRole.System, RecipeInstructions),
            new(ChatRole.System,
            [
                new TextContent("Here is the current state in JSON format:"),
                new TextContent(JsonSerializer.Serialize(
                    input.State!.Value,
                    _jsonSerializerOptions.GetTypeInfo(typeof(JsonElement)))),
                new TextContent("The new state is:")
            ])
        };

        var structuredText = new System.Text.StringBuilder();
        await foreach (var update in base.GetStreamingResponseAsync(
            stateMessages, stateOptions, cancellationToken).ConfigureAwait(false))
        {
            foreach (var content in update.Contents)
            {
                if (content is TextContent { Text: { Length: > 0 } text })
                {
                    structuredText.Append(text);
                }
            }
        }

        var responseText = structuredText.ToString();
        var agentState = string.IsNullOrEmpty(responseText)
            ? null
            : (AgentState?)JsonSerializer.Deserialize(
                responseText,
                _jsonSerializerOptions.GetTypeInfo(typeof(AgentState)));

        if (agentState is not null)
        {
            var stateSnapshot = JsonSerializer.SerializeToElement(
                agentState,
                _jsonSerializerOptions.GetTypeInfo(typeof(AgentState)));

            yield return new ChatResponseUpdate
            {
                RawRepresentation = new StateSnapshotEvent { Snapshot = stateSnapshot }
            };
        }

        // Second LLM call: generate the user-facing summary, streamed as normal text deltas.
        var summaryMessages = new List<ChatMessage>(messages)
        {
            new(ChatRole.Assistant, responseText),
            new(ChatRole.System, "Please provide a concise summary of the recipe in at most two sentences.")
        };

        await foreach (var update in base.GetStreamingResponseAsync(
            summaryMessages, options, cancellationToken).ConfigureAwait(false))
        {
            yield return update;
        }
    }

    private static bool HasProperties(JsonElement element)
    {
        foreach (JsonProperty _ in element.EnumerateObject())
        {
            return true;
        }

        return false;
    }
}
