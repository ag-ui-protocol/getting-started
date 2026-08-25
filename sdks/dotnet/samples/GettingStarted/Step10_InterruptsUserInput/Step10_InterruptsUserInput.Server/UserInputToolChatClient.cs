using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace Step10_InterruptsUserInput.Server;

/// <summary>
/// Bridges a normal LLM tool call and the AG-UI interrupt mechanism, so a real model can
/// pause a run to collect input from the user. The model is given a single
/// <c>request_user_input</c> tool; when it calls that tool this wrapper rewrites the call into
/// an <see cref="InterruptRequestContent"/> (which the hosting layer renders as
/// <c>RUN_FINISHED { outcome: interrupt }</c>). On resume, the matching
/// <see cref="InterruptResponseContent"/> is rewritten back into the
/// <see cref="FunctionCallContent"/> / <see cref="FunctionResultContent"/> pair the model
/// expects, so it continues as if the tool had returned the user's answer.
/// </summary>
internal sealed class UserInputToolChatClient : DelegatingChatClient
{
    public const string ToolName = "request_user_input";

    private static readonly JsonElement ResponseSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "response": { "type": "string" }
          },
          "required": ["response"]
        }
        """).RootElement.Clone();

    public UserInputToolChatClient(IChatClient innerClient)
        : base(innerClient)
    {
    }

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // Inbound: a resumed run carries the InterruptRequestContent (echoed by the client) and
        // the InterruptResponseContent (the user's answer). Rewrite them into the tool
        // call/result pair the model produced, so the model can continue the conversation.
        var rewritten = RewriteResumeToToolResult(messages);

        // Buffer the model's response so a streamed request_user_input call can be detected and
        // converted as a whole.
        var response = await base.GetResponseAsync(rewritten, options, cancellationToken).ConfigureAwait(false);

        var call = response.Messages
            .SelectMany(m => m.Contents)
            .OfType<FunctionCallContent>()
            .FirstOrDefault(c => string.Equals(c.Name, ToolName, StringComparison.Ordinal));

        if (call is not null)
        {
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents =
                [
                    new InterruptRequestContent(call.CallId)
                    {
                        Reason = InterruptReasons.InputRequired,
                        Message = ExtractPrompt(call.Arguments),
                        ResponseSchema = ResponseSchema,
                    },
                ],
                ModelId = response.ModelId,
                ResponseId = response.ResponseId,
            };
            yield break;
        }

        foreach (var update in response.ToChatResponseUpdates())
        {
            yield return update;
        }
    }

    public override Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return GetStreamingResponseAsync(messages, options, cancellationToken)
            .ToChatResponseAsync(cancellationToken);
    }

    private static List<ChatMessage> RewriteResumeToToolResult(IEnumerable<ChatMessage> messages)
    {
        // On resume the SDK surfaces only the user's answer as an InterruptResponseContent (the
        // original interrupt request was stripped from the wire). Reconstruct the
        // assistant tool-call + tool-result pair the model expects so it can continue.
        var result = new List<ChatMessage>();
        foreach (var message in messages)
        {
            var responses = message.Contents.OfType<InterruptResponseContent>().ToList();
            if (responses.Count == 0)
            {
                result.Add(message);
                continue;
            }

            foreach (var response in responses)
            {
                var callId = response.RequestId;
                result.Add(new ChatMessage(
                    ChatRole.Assistant,
                    [
                        new FunctionCallContent(
                            callId: callId,
                            name: ToolName,
                            arguments: new Dictionary<string, object?> { ["prompt"] = "Requested user input." }),
                    ]));
                result.Add(new ChatMessage(
                    ChatRole.Tool,
                    [
                        new FunctionResultContent(callId, ExtractResponse(response.Payload)),
                    ]));
            }

            var others = message.Contents.Where(c => c is not InterruptResponseContent).ToList();
            if (others.Count > 0)
            {
                result.Add(new ChatMessage(message.Role, others));
            }
        }

        return result;
    }

    private static string ExtractPrompt(IDictionary<string, object?>? arguments)
    {
        if (arguments is not null && arguments.TryGetValue("prompt", out var value))
        {
            return value switch
            {
                string s => s,
                JsonElement { ValueKind: JsonValueKind.String } e => e.GetString() ?? string.Empty,
                _ => value?.ToString() ?? string.Empty,
            };
        }

        return "Please provide the requested input.";
    }

    private static string ExtractResponse(JsonElement? payload)
    {
        if (payload is { ValueKind: JsonValueKind.Object } obj
            && obj.TryGetProperty("response", out var response)
            && response.ValueKind == JsonValueKind.String)
        {
            return response.GetString() ?? string.Empty;
        }

        return payload?.ToString() ?? string.Empty;
    }
}
