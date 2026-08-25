using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Step04_HumanInLoop.Server;

/// <summary>
/// A stateless <see cref="DelegatingChatClient"/> that bridges MEAI's
/// <see cref="ToolApprovalRequestContent"/> / <see cref="ToolApprovalResponseContent"/>
/// model and a synthetic frontend tool call named <c>request_approval</c>. This is the
/// "pre-interrupt" approval pattern: AG-UI clients that do not understand the
/// <c>RunFinishedEvent { outcome: interrupt }</c> mechanism still see a normal
/// <c>TOOL_CALL_*</c> triple and reply with a normal tool result.
/// </summary>
internal sealed class ApprovalChatClient : DelegatingChatClient
{
    public const string ApprovalToolName = "request_approval";

    private readonly JsonSerializerOptions _jsonSerializerOptions;

    public ApprovalChatClient(IChatClient innerClient, JsonSerializerOptions jsonSerializerOptions)
        : base(innerClient)
    {
        _jsonSerializerOptions = jsonSerializerOptions;
    }

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // Inbound: rewrite synthetic request_approval call/result pairs back to
        // ToolApprovalRequestContent / ToolApprovalResponseContent so the inner
        // MEAI pipeline (FunctionInvokingChatClient) sees a normal approval flow.
        var rewrittenMessages = RewriteIncomingApprovals(messages);

        await foreach (var update in base.GetStreamingResponseAsync(
            rewrittenMessages, options, cancellationToken).ConfigureAwait(false))
        {
            // Outbound: rewrite ToolApprovalRequestContent emitted by FunctionInvokingChatClient
            // into a synthetic request_approval FunctionCallContent.
            yield return RewriteOutgoingApprovals(update);
        }
    }

    private List<ChatMessage> RewriteIncomingApprovals(IEnumerable<ChatMessage> messages)
    {
        var snapshot = messages as IList<ChatMessage> ?? messages.ToList();

        // First pass: collect callId → reconstructed original FunctionCallContent
        // from synthetic request_approval calls. We need this to pair the result
        // rewrite with the ORIGINAL tool name (and arguments).
        var originalCalls = new Dictionary<string, FunctionCallContent>(StringComparer.Ordinal);
        foreach (var message in snapshot)
        {
            foreach (var content in message.Contents)
            {
                if (content is FunctionCallContent { Name: ApprovalToolName } syntheticCall
                    && DecodeApprovalRequestPayload(syntheticCall.Arguments) is { } payload)
                {
                    var originalArgs = payload.FunctionArguments is { } argsElement
                        ? (IDictionary<string, object?>?)JsonSerializer.Deserialize(
                            argsElement,
                            _jsonSerializerOptions.GetTypeInfo(typeof(IDictionary<string, object?>)))
                        : null;

                    originalCalls[syntheticCall.CallId] = new FunctionCallContent(
                        callId: syntheticCall.CallId,
                        name: payload.FunctionName,
                        arguments: originalArgs);
                }
            }
        }

        var result = new List<ChatMessage>(snapshot.Count);
        foreach (var message in snapshot)
        {
            List<AIContent>? rewritten = null;

            for (int i = 0; i < message.Contents.Count; i++)
            {
                var content = message.Contents[i];

                if (content is FunctionCallContent { Name: ApprovalToolName } syntheticCall
                    && originalCalls.TryGetValue(syntheticCall.CallId, out var originalCall)
                    && DecodeApprovalRequestPayload(syntheticCall.Arguments) is { } reqPayload)
                {
                    rewritten ??= CopyContents(message.Contents, i);
                    rewritten.Add(new ToolApprovalRequestContent(reqPayload.ApprovalId, originalCall));
                }
                else if (content is FunctionResultContent resultContent
                    && originalCalls.TryGetValue(resultContent.CallId, out var resultOriginalCall)
                    && DecodeApprovalResponsePayload(resultContent) is { } resPayload)
                {
                    rewritten ??= CopyContents(message.Contents, i);
                    rewritten.Add(new ToolApprovalResponseContent(
                        resPayload.ApprovalId, resPayload.Approved, resultOriginalCall));
                }
                else
                {
                    rewritten?.Add(content);
                }
            }

            result.Add(rewritten is null
                ? message
                : new ChatMessage(message.Role, rewritten)
                {
                    AuthorName = message.AuthorName,
                    MessageId = message.MessageId,
                    CreatedAt = message.CreatedAt,
                    RawRepresentation = message.RawRepresentation,
                    AdditionalProperties = message.AdditionalProperties,
                });
        }

        return result;
    }

    private ApprovalRequest? DecodeApprovalRequestPayload(IDictionary<string, object?>? arguments)
    {
        if (arguments is null || !arguments.TryGetValue("request", out var requestObj))
        {
            return null;
        }

        if (requestObj is JsonElement element)
        {
            return (ApprovalRequest?)element.Deserialize(
                _jsonSerializerOptions.GetTypeInfo(typeof(ApprovalRequest)));
        }

        return null;
    }

    private ApprovalResponse? DecodeApprovalResponsePayload(FunctionResultContent resultContent)
    {
        return resultContent.Result switch
        {
            JsonElement element => (ApprovalResponse?)element.Deserialize(
                _jsonSerializerOptions.GetTypeInfo(typeof(ApprovalResponse))),
            string str => (ApprovalResponse?)JsonSerializer.Deserialize(
                str, _jsonSerializerOptions.GetTypeInfo(typeof(ApprovalResponse))),
            _ => null,
        };
    }

    private ChatResponseUpdate RewriteOutgoingApprovals(ChatResponseUpdate update)
    {
        if (!update.Contents.OfType<ToolApprovalRequestContent>().Any())
        {
            return update;
        }

        var rewritten = new List<AIContent>(update.Contents.Count);
        foreach (var content in update.Contents)
        {
            if (content is ToolApprovalRequestContent { ToolCall: FunctionCallContent originalCall } approval)
            {
                var payload = new ApprovalRequest
                {
                    ApprovalId = approval.RequestId,
                    FunctionName = originalCall.Name,
                    FunctionArguments = originalCall.Arguments is null
                        ? null
                        : JsonSerializer.SerializeToElement(
                            originalCall.Arguments,
                            _jsonSerializerOptions.GetTypeInfo(typeof(IDictionary<string, object?>))),
                    Message = $"Approve execution of '{originalCall.Name}'?",
                };

                rewritten.Add(new FunctionCallContent(
                    callId: originalCall.CallId,
                    name: ApprovalToolName,
                    arguments: new Dictionary<string, object?>
                    {
                        ["request"] = JsonSerializer.SerializeToElement(
                            payload, _jsonSerializerOptions.GetTypeInfo(typeof(ApprovalRequest))),
                    }));
            }
            else
            {
                rewritten.Add(content);
            }
        }

        return new ChatResponseUpdate
        {
            Role = update.Role,
            Contents = rewritten,
            MessageId = update.MessageId,
            AuthorName = update.AuthorName,
            CreatedAt = update.CreatedAt,
            RawRepresentation = update.RawRepresentation,
            ResponseId = update.ResponseId,
            AdditionalProperties = update.AdditionalProperties,
            FinishReason = update.FinishReason,
            ModelId = update.ModelId,
        };
    }

    private static List<AIContent> CopyContents(IList<AIContent> contents, int upToExclusive)
    {
        var copy = new List<AIContent>(upToExclusive);
        for (int i = 0; i < upToExclusive; i++)
        {
            copy.Add(contents[i]);
        }
        return copy;
    }
}
