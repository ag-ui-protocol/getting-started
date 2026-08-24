using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace CrossLanguage.TestServer;

internal static class ToolApprovalScenariosRoute
{
    public static IEndpointConventionBuilder MapToolApprovalScenarios(
        this IEndpointRouteBuilder endpoints,
        string pattern)
    {
        return endpoints.MapPost(pattern, (
            [FromRoute] string scenario,
            [FromBody] RunAgentInput input,
            [FromServices] IOptions<JsonOptions> jsonOptions,
            CancellationToken cancellationToken) =>
        {
            var context = input.ToChatRequestContext(jsonOptions.Value.SerializerOptions);
            if (scenario == "server-only")
            {
                context.ChatOptions.Tools ??= [];
                context.ChatOptions.Tools.Add(
                    AIFunctionFactory.Create(
                        () => "server-result",
                        "get_weather"));
            }
            else if (scenario == "server-approval")
            {
                context.ChatOptions.Tools ??= [];
                context.ChatOptions.Tools.Add(
                    new ApprovalRequiredAIFunction(
                        AIFunctionFactory.Create(
                            () => "protected-server-result",
                            "delete_file")));
            }
            else if (scenario == "mixed-client-local-approval")
            {
                context.ChatOptions.Tools ??= [];
                context.ChatOptions.Tools.Add(
                    AIFunctionFactory.Create(
                        () => "normal-server-result",
                        "get_weather"));
            }

            using var chatClient = new FunctionInvokingChatClient(
                new ScenarioChatClient(scenario));

            var updates = chatClient.GetStreamingResponseAsync(
                context.Messages,
                context.ChatOptions,
                cancellationToken);
            var events = updates.AsAGUIEventStreamAsync(context, cancellationToken);

            return TypedResults.ServerSentEvents(
                AgenticChatRoute.WrapAsSseItems(events, cancellationToken));
        });
    }

    private sealed class ScenarioChatClient(string scenario) : IChatClient
    {
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var history = messages.ToList();
            if (history.SelectMany(message => message.Contents)
                .OfType<FunctionResultContent>()
                .FirstOrDefault() is { } result)
            {
                var resultText = result.Result?.ToString() ?? string.Empty;
                var outcome = resultText.Contains(
                    "rejected",
                    StringComparison.OrdinalIgnoreCase)
                    ? "rejected"
                    : "approved";
                yield return new ChatResponseUpdate(
                    ChatRole.Assistant,
                    scenario is "server-approval"
                        or "client-local-approval"
                        or "mixed-client-local-approval"
                        ? $"completed:{scenario}:{outcome}"
                        : $"completed:{scenario}");
                yield break;
            }

            if (scenario is "client-only" or "client-local-approval")
            {
                yield return new ChatResponseUpdate
                {
                    Role = ChatRole.Assistant,
                    Contents =
                    [
                        new FunctionCallContent(
                            "call-client-only",
                            "get_user_location",
                            new Dictionary<string, object?>()),
                    ],
                    FinishReason = ChatFinishReason.ToolCalls,
                };
                yield break;
            }

            if (scenario == "server-only")
            {
                yield return new ChatResponseUpdate
                {
                    Role = ChatRole.Assistant,
                    Contents =
                    [
                        new FunctionCallContent(
                            "call-server-only",
                            "get_weather",
                            new Dictionary<string, object?>()),
                    ],
                    FinishReason = ChatFinishReason.ToolCalls,
                };
                yield break;
            }

            if (scenario == "server-approval")
            {
                yield return new ChatResponseUpdate
                {
                    Role = ChatRole.Assistant,
                    Contents =
                    [
                        new FunctionCallContent(
                            "call-server-approval",
                            "delete_file",
                            new Dictionary<string, object?>
                            {
                                ["path"] = "report.txt",
                            }),
                    ],
                    FinishReason = ChatFinishReason.ToolCalls,
                };
                yield break;
            }

            if (scenario == "mixed-client-local-approval")
            {
                yield return new ChatResponseUpdate
                {
                    Role = ChatRole.Assistant,
                    Contents =
                    [
                        new FunctionCallContent(
                            "call-mixed-client",
                            "get_user_location",
                            new Dictionary<string, object?>()),
                        new FunctionCallContent(
                            "call-mixed-server",
                            "get_weather",
                            new Dictionary<string, object?>()),
                    ],
                    FinishReason = ChatFinishReason.ToolCalls,
                };
                yield break;
            }

            throw new InvalidOperationException($"Unknown tool-approval scenario '{scenario}'.");
        }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }
}
