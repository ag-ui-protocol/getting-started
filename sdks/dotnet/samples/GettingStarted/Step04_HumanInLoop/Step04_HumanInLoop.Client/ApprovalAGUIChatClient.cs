using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Step04_HumanInLoop.Client;

/// <summary>
/// Client-side counterpart of the server-side ApprovalChatClient. Wraps an
/// <see cref="IChatClient"/> (typically the AG-UI <c>AGUIChatClient</c>) so calling code on
/// the client side sees standard MEAI <see cref="ToolApprovalRequestContent"/> /
/// <see cref="ToolApprovalResponseContent"/> instead of the synthetic
/// <c>request_approval</c> tool call/result encoding used on the wire.
/// </summary>
internal sealed class ApprovalAGUIChatClient : DelegatingChatClient
{
    public const string ApprovalToolName = "request_approval";

    private readonly JsonSerializerOptions _jsonSerializerOptions;

    public ApprovalAGUIChatClient(IChatClient innerClient, JsonSerializerOptions jsonSerializerOptions)
        : base(innerClient)
    {
        _jsonSerializerOptions = jsonSerializerOptions;
    }

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // Outbound: replace ToolApprovalRequestContent / ToolApprovalResponseContent in the
        // outgoing message history with the synthetic request_approval call/result pair so
        // the AG-UI server receives a normal frontend-tool roundtrip.
        var rewrittenMessages = RewriteOutgoingApprovals(messages);

        await foreach (var update in base.GetStreamingResponseAsync(
            rewrittenMessages, options, cancellationToken).ConfigureAwait(false))
        {
            // Inbound: convert synthetic request_approval calls in the response stream back
            // to ToolApprovalRequestContent so the calling code sees standard MEAI types.
            yield return RewriteIncomingApprovals(update);
        }
    }

    private List<ChatMessage> RewriteOutgoingApprovals(IEnumerable<ChatMessage> messages)
    {
        var result = new List<ChatMessage>();
        foreach (var message in messages)
        {
            // ToolApprovalResponseContent lives in a User message in MEAI, but its wire
            // encoding is a FunctionResultContent which AG-UI carries in a Tool message.
            // Split such messages: user-role contents stay in a User message, the encoded
            // FRC moves into a sibling Tool message.
            List<AIContent>? userContents = null;
            List<AIContent>? toolContents = null;
            List<AIContent>? rewrittenAssistantContents = null;

            for (int i = 0; i < message.Contents.Count; i++)
            {
                var content = message.Contents[i];

                if (content is ToolApprovalRequestContent { ToolCall: FunctionCallContent originalRequestCall } request)
                {
                    rewrittenAssistantContents ??= CopyContents(message.Contents, i);
                    rewrittenAssistantContents.Add(EncodeRequestAsCall(request, originalRequestCall));
                }
                else if (content is ToolApprovalResponseContent { ToolCall: FunctionCallContent originalResponseCall } response)
                {
                    if (userContents is null && message.Contents.Count > 1)
                    {
                        userContents = CopyContents(message.Contents, i);
                    }

                    toolContents ??= [];
                    toolContents.Add(EncodeResponseAsResult(response, originalResponseCall));
                }
                else
                {
                    rewrittenAssistantContents?.Add(content);
                    userContents?.Add(content);
                }
            }

            if (rewrittenAssistantContents is not null)
            {
                result.Add(new ChatMessage(message.Role, rewrittenAssistantContents)
                {
                    AuthorName = message.AuthorName,
                    MessageId = message.MessageId,
                    CreatedAt = message.CreatedAt,
                    RawRepresentation = message.RawRepresentation,
                    AdditionalProperties = message.AdditionalProperties,
                });
            }
            else if (toolContents is not null)
            {
                if (userContents is { Count: > 0 })
                {
                    result.Add(new ChatMessage(message.Role, userContents)
                    {
                        AuthorName = message.AuthorName,
                        MessageId = message.MessageId,
                        CreatedAt = message.CreatedAt,
                        RawRepresentation = message.RawRepresentation,
                        AdditionalProperties = message.AdditionalProperties,
                    });
                }

                result.Add(new ChatMessage(ChatRole.Tool, toolContents));
            }
            else
            {
                result.Add(message);
            }
        }

        return result;
    }

    private FunctionCallContent EncodeRequestAsCall(
        ToolApprovalRequestContent request,
        FunctionCallContent originalCall)
    {
        var payload = new ApprovalRequest
        {
            ApprovalId = request.RequestId,
            FunctionName = originalCall.Name,
            FunctionArguments = originalCall.Arguments is null
                ? null
                : JsonSerializer.SerializeToElement(
                    originalCall.Arguments,
                    _jsonSerializerOptions.GetTypeInfo(typeof(IDictionary<string, object?>))),
            Message = $"Approve execution of '{originalCall.Name}'?",
        };

        return new FunctionCallContent(
            callId: originalCall.CallId,
            name: ApprovalToolName,
            arguments: new Dictionary<string, object?>
            {
                ["request"] = JsonSerializer.SerializeToElement(
                    payload, _jsonSerializerOptions.GetTypeInfo(typeof(ApprovalRequest))),
            });
    }

    private FunctionResultContent EncodeResponseAsResult(
        ToolApprovalResponseContent response,
        FunctionCallContent originalCall)
    {
        var payload = new ApprovalResponse
        {
            ApprovalId = response.RequestId,
            Approved = response.Approved,
        };

        return new FunctionResultContent(
            callId: originalCall.CallId,
            result: JsonSerializer.SerializeToElement(
                payload, _jsonSerializerOptions.GetTypeInfo(typeof(ApprovalResponse))));
    }

    private ChatResponseUpdate RewriteIncomingApprovals(ChatResponseUpdate update)
    {
        if (!update.Contents.OfType<FunctionCallContent>().Any(c => c.Name == ApprovalToolName))
        {
            return update;
        }

        var rewritten = new List<AIContent>(update.Contents.Count);
        foreach (var content in update.Contents)
        {
            if (content is FunctionCallContent { Name: ApprovalToolName } syntheticCall
                && DecodeApprovalRequest(syntheticCall.Arguments) is { } payload)
            {
                var originalArgs = payload.FunctionArguments is { } argsElement
                    ? (IDictionary<string, object?>?)JsonSerializer.Deserialize(
                        argsElement,
                        _jsonSerializerOptions.GetTypeInfo(typeof(IDictionary<string, object?>)))
                    : null;

                var originalCall = new FunctionCallContent(
                    callId: syntheticCall.CallId,
                    name: payload.FunctionName,
                    arguments: originalArgs);

                rewritten.Add(new ToolApprovalRequestContent(payload.ApprovalId, originalCall));
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

    private ApprovalRequest? DecodeApprovalRequest(IDictionary<string, object?>? arguments)
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
