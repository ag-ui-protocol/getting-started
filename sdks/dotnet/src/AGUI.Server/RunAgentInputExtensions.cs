#pragma warning disable CA2227 // Collection properties should be read-only — Tools is read-write by design

using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

/// <summary>
/// Extension methods for adapting <see cref="RunAgentInput"/> to the
/// Microsoft.Extensions.AI request shape.
/// </summary>
public static class RunAgentInputExtensions
{
    /// <summary>
    /// Adapts an AG-UI <see cref="RunAgentInput"/> into a <see cref="ChatRequestContext"/>
    /// containing a <see cref="ChatMessage"/> list, a <see cref="ChatOptions"/> with the
    /// originating input stashed on <see cref="ChatOptions.AdditionalProperties"/> (recoverable via
    /// <see cref="TryGetRunAgentInput"/>), the
    /// supplied <see cref="JsonSerializerOptions"/>, and (optionally) caller-provided
    /// <see cref="AGUIStreamOptions"/>.
    /// </summary>
    /// <param name="input">The AG-UI input to adapt.</param>
    /// <param name="jsonSerializerOptions">JSON serializer options used both for downstream serialization and by the stream converter. Typically resolved from the host's configured JSON options by the caller.</param>
    /// <param name="streamOptions">
    /// Optional stream-converter configuration (interrupt mapper, result mappings, etc.).
    /// Typically resolved by the caller from DI or endpoint metadata. If <see langword="null"/>,
    /// a default instance is created. The returned context owns this instance.
    /// </param>
    /// <returns>A <see cref="ChatRequestContext"/> with the adapted request, ready to be
    /// passed to <see cref="IChatClient.GetStreamingResponseAsync(IEnumerable{ChatMessage}, ChatOptions?, System.Threading.CancellationToken)"/>
    /// and then to <see cref="ChatResponseUpdateAGUIExtensions.AsAGUIEventStreamAsync(IAsyncEnumerable{ChatResponseUpdate}, ChatRequestContext, System.Threading.CancellationToken)"/>.</returns>
    /// <remarks>
    /// Client tools declared on <see cref="RunAgentInput.Tools"/> are wired through the
    /// approval-flow pipeline and installed on <see cref="ChatRequestContext.ChatOptions"/>.<c>Tools</c>
    /// automatically — callers do not add them manually.
    /// </remarks>
    public static ChatRequestContext ToChatRequestContext(
        this RunAgentInput input,
        JsonSerializerOptions jsonSerializerOptions,
        AGUIStreamOptions? streamOptions = null)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(jsonSerializerOptions);

        var messages = input.Messages.AsChatMessages().ToList();
        var clientTools = input.Tools?.AsAITools().ToList();

        var clientToolNames = new HashSet<string>(StringComparer.Ordinal);
        if (clientTools is not null)
        {
            foreach (var tool in clientTools)
            {
                clientToolNames.Add(tool.Name);
            }
        }

        // Translate AG-UI Resume entries into MEAI content on the message list so the
        // inner pipeline (custom IChatClient, FICC, etc.) sees standard MEAI types.
        // Tool-approval-shaped resume payloads (with a `toolCall` field) become a
        // ToolApprovalRequestContent + ToolApprovalResponseContent pair so
        // FunctionInvokingChatClient resumes the tool naturally; everything else becomes
        // a generic InterruptResponseContent.
        var resumedClientResults = new Dictionary<string, FunctionResultContent>(StringComparer.Ordinal);
        var resumedApprovalCallIds = new HashSet<string>(StringComparer.Ordinal);
        var resumeMessageStartIndex = messages.Count;
        var originalCallsById = messages.SelectMany(message => message.Contents)
            .OfType<FunctionCallContent>()
            .ToDictionary(call => call.CallId, StringComparer.Ordinal);
        if (input.Resume is { Count: > 0 } resumeEntries)
        {
            var genericResponses = new List<AIContent>(resumeEntries.Count);
            var approvalRequests = new List<AIContent>(resumeEntries.Count);
            var approvalResponses = new List<AIContent>(resumeEntries.Count);
            foreach (var resume in resumeEntries)
            {
                if (TryDecodeToolApprovalResume(resume, jsonSerializerOptions,
                    out var approvalRequest, out var approvalResponse, out var result))
                {
                    if (approvalRequest!.ToolCall is not FunctionCallContent resumedCall
                        || !originalCallsById.TryGetValue(resumedCall.CallId, out var originalCall)
                        || !ToolCallsMatch(originalCall, resumedCall))
                    {
                        throw new InvalidOperationException(
                            $"Approval Resume '{resume.InterruptId}' does not match its original tool call.");
                    }

                    approvalRequest = new ToolApprovalRequestContent(
                        approvalRequest.RequestId,
                        originalCall);
                    approvalResponse = approvalRequest.CreateResponse(
                        approvalResponse!.Approved,
                        approvalResponse.Reason);
                    result = result is null
                        ? null
                        : new FunctionResultContent(originalCall.CallId, result.Result);
                    resumedApprovalCallIds.Add(originalCall.CallId);

                    approvalRequests.Add(approvalRequest!);
                    approvalResponses.Add(approvalResponse!);
                    if (result is not null
                        && approvalRequest!.ToolCall is FunctionCallContent call
                        && clientToolNames.Contains(call.Name))
                    {
                        resumedClientResults[result.CallId] = result;
                    }
                    continue;
                }

                genericResponses.Add(new InterruptResponseContent(resume.InterruptId)
                {
                    Payload = resume.Payload,
                    Metadata = resume.Metadata,
                });
            }

            if (approvalRequests.Count > 0)
            {
                messages.Add(new ChatMessage(ChatRole.Assistant, approvalRequests));
                messages.Add(new ChatMessage(ChatRole.User, approvalResponses));
            }

            if (genericResponses.Count > 0)
            {
                messages.Add(new ChatMessage(ChatRole.User, genericResponses));
            }
        }

        var chatOptions = new ChatOptions
        {
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                [AGUIConstants.RunAgentInputKey] = input,
            },
        };

        var isContinuation = ConfigureForMixedInvocation(
            chatOptions,
            clientTools,
            clientToolNames,
            messages,
            resumedClientResults,
            resumedApprovalCallIds,
            resumeMessageStartIndex);

        return new ChatRequestContext(
            input,
            messages,
            chatOptions,
            streamOptions ?? new AGUIStreamOptions(),
            jsonSerializerOptions,
            isContinuation,
            clientToolNames);
    }

    /// <summary>
    /// Recovers the originating AG-UI <see cref="RunAgentInput"/> that
    /// <see cref="ToChatRequestContext"/> stashed on the request's
    /// <see cref="ChatOptions"/>.<see cref="ChatOptions.AdditionalProperties"/>. Delegating
    /// <see cref="IChatClient"/> implementations and agents use this to read AG-UI inputs such as
    /// <see cref="RunAgentInput.State"/> without depending on the hosting layer's internals.
    /// </summary>
    /// <param name="options">The chat options flowed to the inner client or agent.</param>
    /// <param name="input">
    /// When this method returns <see langword="true"/>, contains the recovered
    /// <see cref="RunAgentInput"/>; otherwise <see langword="null"/>.
    /// </param>
    /// <returns><see langword="true"/> if an AG-UI input was present; otherwise <see langword="false"/>.</returns>
    public static bool TryGetRunAgentInput(this ChatOptions options, [NotNullWhen(true)] out RunAgentInput? input)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (options.AdditionalProperties?.TryGetValue(AGUIConstants.RunAgentInputKey, out var value) is true
            && value is RunAgentInput runAgentInput)
        {
            input = runAgentInput;
            return true;
        }

        input = null;
        return false;
    }

    private static bool TryDecodeToolApprovalResume(
        AGUIResume resume,
        JsonSerializerOptions jsonSerializerOptions,
        out ToolApprovalRequestContent? request,
        out ToolApprovalResponseContent? response,
        out FunctionResultContent? result)
    {
        request = null;
        response = null;
        result = null;

        if (resume.Payload is not { ValueKind: JsonValueKind.Object } element
            || !element.TryGetProperty("toolCall", out _))
        {
            return false;
        }

        AGUIToolApprovalResumePayload? payload;
        try
        {
            payload = (AGUIToolApprovalResumePayload?)element.Deserialize(
                jsonSerializerOptions.GetTypeInfo(typeof(AGUIToolApprovalResumePayload)));
        }
        catch (JsonException)
        {
            return false;
        }

        if (payload?.ToolCall is null)
        {
            return false;
        }

        var fcc = new FunctionCallContent(
            callId: payload.ToolCall.CallId ?? string.Empty,
            name: payload.ToolCall.Name ?? string.Empty,
            arguments: payload.ToolCall.Arguments);

        request = new ToolApprovalRequestContent(resume.InterruptId, fcc);
        response = new ToolApprovalResponseContent(resume.InterruptId, payload.Approved, fcc);
        result = new FunctionResultContent(fcc.CallId, payload.Result);
        return true;
    }

    private static bool ToolCallsMatch(
        FunctionCallContent originalCall,
        FunctionCallContent resumedCall)
    {
        if (!string.Equals(originalCall.Name, resumedCall.Name, StringComparison.Ordinal))
        {
            return false;
        }

        var typeInfo = AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!;
        var originalArguments = JsonSerializer.SerializeToElement(originalCall.Arguments, typeInfo);
        var resumedArguments = JsonSerializer.SerializeToElement(resumedCall.Arguments, typeInfo);
        return JsonElement.DeepEquals(originalArguments, resumedArguments);
    }

    /// <summary>
    /// Configures <paramref name="chatOptions"/> for mixed server/client tool invocation.
    /// On the first turn, wraps client tools in <see cref="ApprovalRequiredAIFunction"/> so FICC
    /// terminates with approval requests for all tools. On continuation (client tool results
    /// present in messages), creates proxy functions for client tools and injects approval
    /// responses so FICC executes all pending tool calls.
    /// </summary>
    /// <returns><see langword="true"/> if this is a continuation turn; <see langword="false"/> otherwise (either no client tools, or first turn).</returns>
    private static bool ConfigureForMixedInvocation(
        ChatOptions chatOptions,
        IList<AITool>? clientTools,
        HashSet<string> clientToolNames,
        List<ChatMessage> chatMessages,
        Dictionary<string, FunctionResultContent> resumedClientResults,
        HashSet<string> resumedApprovalCallIds,
        int resumeMessageStartIndex)
    {
        if (resumedApprovalCallIds.Count > 0)
        {
            var resumedAssistantCallIndex = FindLatestAssistantFunctionCallIndex(chatMessages);
            if (resumedAssistantCallIndex < 0
                || !IsResumeForLatestCallBatch(
                    chatMessages,
                    resumedAssistantCallIndex,
                    resumeMessageStartIndex,
                    resumedApprovalCallIds))
            {
                throw new InvalidOperationException(
                    "Approval Resume entries do not match the complete latest unresolved tool-call batch.");
            }

            ProcessContinuation(
                chatOptions,
                clientTools ?? [],
                chatMessages,
                resumedClientResults,
                resumedAssistantCallIndex);
            return true;
        }

        if (clientTools is not { Count: > 0 })
        {
            return false;
        }

        if (TryGetClientToolResults(
            chatMessages,
            clientToolNames,
            out var clientCallResults,
            out var assistantCallIndex))
        {
            if (chatMessages[assistantCallIndex].Contents
                .OfType<FunctionCallContent>()
                .Any(call => !clientToolNames.Contains(call.Name)))
            {
                throw new InvalidOperationException(
                    "Mixed client/server tool continuations require a complete approval Resume batch.");
            }

            ProcessContinuation(
                chatOptions,
                clientTools,
                chatMessages,
                clientCallResults,
                assistantCallIndex);
            return true;
        }

        // First turn: wrap client tools in ApprovalRequiredAIFunction.
        // When FICC sees any ApprovalRequired tool called, it converts ALL FCCs in the
        // response to ToolApprovalRequestContent and terminates. The stream converter
        // unwraps them back to plain TOOL_CALL events.
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            if (tool is AIFunctionDeclaration declaration)
            {
                chatOptions.Tools.Add(
                    new ApprovalRequiredAIFunction(new ClientToolAIFunction(declaration)));
            }
            else
            {
                chatOptions.Tools.Add(tool);
            }
        }

        return false;
    }

    private static bool IsResumeForLatestCallBatch(
        List<ChatMessage> messages,
        int assistantCallIndex,
        int resumeMessageStartIndex,
        ICollection<string> resumedCallIds)
    {
        var batchCallIds = messages[assistantCallIndex].Contents
            .OfType<FunctionCallContent>()
            .Select(call => call.CallId)
            .ToHashSet(StringComparer.Ordinal);
        if (!batchCallIds.SetEquals(resumedCallIds))
        {
            return false;
        }

        var persistedResultCallIds = messages
            .Skip(assistantCallIndex + 1)
            .Take(resumeMessageStartIndex - assistantCallIndex - 1)
            .SelectMany(message => message.Contents)
            .OfType<FunctionResultContent>()
            .Select(result => result.CallId);
        if (persistedResultCallIds.Any(batchCallIds.Contains))
        {
            return false;
        }

        for (var i = assistantCallIndex + 1; i < resumeMessageStartIndex; i++)
        {
            if (messages[i].Contents.Any(content => content is not FunctionResultContent))
            {
                return false;
            }
        }

        return true;
    }

    private static int FindLatestAssistantFunctionCallIndex(List<ChatMessage> messages)
    {
        for (var i = messages.Count - 1; i >= 0; i--)
        {
            if (messages[i].Role == ChatRole.Assistant
                && messages[i].Contents.Any(content => content is FunctionCallContent))
            {
                return i;
            }
        }

        return -1;
    }

    private static bool TryGetClientToolResults(
        List<ChatMessage> messages,
        HashSet<string> clientToolNames,
        out Dictionary<string, FunctionResultContent> clientCallResults,
        out int assistantCallIndex)
    {
        clientCallResults = new Dictionary<string, FunctionResultContent>(StringComparer.Ordinal);
        assistantCallIndex = -1;
        var clientCallIds = new HashSet<string>(StringComparer.Ordinal);
        var batchCallIds = new HashSet<string>(StringComparer.Ordinal);
        var resultCallIds = new HashSet<string>(StringComparer.Ordinal);

        for (var i = messages.Count - 1; i >= 0; i--)
        {
            foreach (var content in messages[i].Contents)
            {
                if (content is FunctionCallContent fcc && clientToolNames.Contains(fcc.Name))
                {
                    clientCallIds.Add(fcc.CallId);
                    assistantCallIndex = i;
                }
                if (content is FunctionCallContent batchCall)
                {
                    batchCallIds.Add(batchCall.CallId);
                }
            }

            if (assistantCallIndex >= 0)
            {
                break;
            }
        }

        if (assistantCallIndex < 0)
        {
            return false;
        }

        // A continuation ends with results and approval responses for the latest client-tool
        // batch. Later ordinary content means that batch belongs to completed history.
        for (var i = assistantCallIndex + 1; i < messages.Count; i++)
        {
            foreach (var content in messages[i].Contents)
            {
                if (content is FunctionResultContent frc && clientCallIds.Contains(frc.CallId))
                {
                    clientCallResults[frc.CallId] = frc;
                }
                if (content is FunctionResultContent result)
                {
                    resultCallIds.Add(result.CallId);
                }
                else if (content is not ToolApprovalRequestContent
                    && content is not ToolApprovalResponseContent)
                {
                    clientCallResults.Clear();
                    assistantCallIndex = -1;
                    return false;
                }
            }
        }

        if (batchCallIds.Count > 0 && batchCallIds.All(resultCallIds.Contains))
        {
            clientCallResults.Clear();
            assistantCallIndex = -1;
            return false;
        }

        return clientCallResults.Count > 0;
    }

    private static void ProcessContinuation(
        ChatOptions chatOptions,
        IList<AITool> clientTools,
        List<ChatMessage> chatMessages,
        Dictionary<string, FunctionResultContent> clientCallResults,
        int assistantCallIndex)
    {
        var assistantMessage = chatMessages[assistantCallIndex];
        var existingRequests = new List<ToolApprovalRequestContent>();
        var existingResponses = new Dictionary<string, ToolApprovalResponseContent>(StringComparer.Ordinal);
        RemoveApprovalContent(chatMessages, existingRequests, existingResponses);
        RemoveClientResults(chatMessages, clientCallResults.Keys);
        assistantCallIndex = chatMessages.IndexOf(assistantMessage);
        if (assistantCallIndex < 0)
        {
            throw new InvalidOperationException("The mixed tool-call message was removed while rebuilding its approval batch.");
        }

        var existingRequestsByCallId = existingRequests
            .Where(request => request.ToolCall is FunctionCallContent)
            .ToDictionary(request => request.ToolCall.CallId, StringComparer.Ordinal);
        var mergedCallIds = new HashSet<string>(StringComparer.Ordinal);
        var approvalResponses = new List<AIContent>();
        var approvalRequests = new List<AIContent>(assistantMessage.Contents.Count + existingRequests.Count);

        foreach (var content in assistantMessage.Contents)
        {
            if (content is not FunctionCallContent call)
            {
                approvalRequests.Add(content);
                continue;
            }

            if (existingRequestsByCallId.TryGetValue(call.CallId, out var existingRequest))
            {
                approvalRequests.Add(existingRequest);
                mergedCallIds.Add(call.CallId);
                if (existingResponses.TryGetValue(existingRequest.RequestId, out var existingResponse))
                {
                    approvalResponses.Add(existingResponse);
                }
                continue;
            }

            var request = new ToolApprovalRequestContent($"approval_{call.CallId}", call)
            {
#pragma warning disable MEAI001
                RequiresConfirmation = false,
#pragma warning restore MEAI001
            };
            approvalRequests.Add(request);
            approvalResponses.Add(request.CreateResponse(approved: true));
        }

        foreach (var request in existingRequests)
        {
            if (mergedCallIds.Contains(request.ToolCall.CallId))
            {
                continue;
            }

            approvalRequests.Add(request);
            if (existingResponses.TryGetValue(request.RequestId, out var response))
            {
                approvalResponses.Add(response);
            }
        }

        var replacement = assistantMessage.Clone();
        replacement.Contents = approvalRequests;
        chatMessages[assistantCallIndex] = replacement;
        chatMessages.Insert(assistantCallIndex + 1, new ChatMessage(ChatRole.User, approvalResponses));

        // Keep the result proxy approval-wrapped. It resolves the original approved call from the
        // exact call id, while any new model-issued call stops for fresh client execution.
        AddClientToolProxies(chatOptions, clientTools, clientCallResults);
    }

    private static void AddClientToolProxies(
        ChatOptions chatOptions,
        IList<AITool> clientTools,
        IReadOnlyDictionary<string, FunctionResultContent> clientCallResults)
    {
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            if (tool is AIFunctionDeclaration declaration)
            {
                chatOptions.Tools.Add(
                    new ApprovalRequiredAIFunction(
                        new ClientToolAIFunction(declaration, clientCallResults)));
            }
            else
            {
                chatOptions.Tools.Add(tool);
            }
        }
    }

    private static void RemoveApprovalContent(
        List<ChatMessage> chatMessages,
        List<ToolApprovalRequestContent> approvalRequests,
        Dictionary<string, ToolApprovalResponseContent> approvalResponses)
    {
        for (var i = 0; i < chatMessages.Count;)
        {
            var message = chatMessages[i];
            var retainedContents = new List<AIContent>(message.Contents.Count);

            foreach (var content in message.Contents)
            {
                if (content is ToolApprovalRequestContent request)
                {
                    approvalRequests.Add(request);
                }
                else if (content is ToolApprovalResponseContent response)
                {
                    approvalResponses[response.RequestId] = response;
                }
                else
                {
                    retainedContents.Add(content);
                }
            }

            if (retainedContents.Count == message.Contents.Count)
            {
                i++;
                continue;
            }

            if (retainedContents.Count == 0)
            {
                chatMessages.RemoveAt(i);
            }
            else
            {
                var replacement = message.Clone();
                replacement.Contents = retainedContents;
                chatMessages[i] = replacement;
                i++;
            }
        }
    }

    private static void RemoveClientResults(
        List<ChatMessage> chatMessages,
        ICollection<string> clientResultCallIds)
    {
        for (var i = chatMessages.Count - 1; i >= 0; i--)
        {
            var message = chatMessages[i];
            var retainedContents = message.Contents
                .Where(content => content is not FunctionResultContent result
                    || !clientResultCallIds.Contains(result.CallId))
                .ToList();

            if (retainedContents.Count == message.Contents.Count)
            {
                continue;
            }

            if (retainedContents.Count == 0)
            {
                chatMessages.RemoveAt(i);
            }
            else
            {
                var replacement = message.Clone();
                replacement.Contents = retainedContents;
                chatMessages[i] = replacement;
            }
        }
    }
}
