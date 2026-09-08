using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Step14_Telemetry.Server;

// Deterministic offline model driving three telemetry scenarios from the user's prompt:
//   - "weather"  -> calls the backend get_weather tool (server-side execution)
//   - "near me"  -> calls get_weather (backend) AND get_user_location (a client/frontend tool)
//   - "delete"   -> calls the approval-gated delete_file tool (pauses the run for approval)
// Once any tool has produced a result it answers with text (the continuation turn). This keeps
// the sample runnable offline while producing realistic span trees.
internal sealed class FakeChatClient : IChatClient
{
    public void Dispose()
    {
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceType == typeof(IChatClient) ? this : null;

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("Use GetStreamingResponseAsync for AG-UI.");

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var list = messages.ToList();
        var toolHasRun = list.Any(m => m.Contents.Any(c => c is FunctionResultContent));
        var lastUser = list.LastOrDefault(m => m.Role == ChatRole.User)?.Text ?? string.Empty;

        if (toolHasRun)
        {
            yield return Text("All set \u2014 here's your answer based on the tools I called.");
        }
        else if (lastUser.Contains("near me", StringComparison.OrdinalIgnoreCase))
        {
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                ModelId = "fake-model",
                FinishReason = ChatFinishReason.ToolCalls,
                Contents =
                [
                    new FunctionCallContent("call_weather", "get_weather", new Dictionary<string, object?> { ["city"] = "Amsterdam" }),
                    new FunctionCallContent("call_location", "get_user_location", new Dictionary<string, object?>()),
                ],
            };
        }
        else if (lastUser.Contains("delete", StringComparison.OrdinalIgnoreCase))
        {
            yield return Call("call_delete", "delete_file", new Dictionary<string, object?> { ["path"] = "report-draft.txt" });
        }
        else
        {
            yield return Call("call_weather", "get_weather", new Dictionary<string, object?> { ["city"] = "Paris" });
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static ChatResponseUpdate Text(string text) =>
        new(ChatRole.Assistant, text) { ModelId = "fake-model", MessageId = "msg_final" };

    private static ChatResponseUpdate Call(string id, string name, IDictionary<string, object?> args) =>
        new()
        {
            Role = ChatRole.Assistant,
            ModelId = "fake-model",
            FinishReason = ChatFinishReason.ToolCalls,
            Contents = [new FunctionCallContent(id, name, args)],
        };
}
