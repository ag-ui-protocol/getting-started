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
        if (input.Resume is { Count: > 0 } resumeEntries)
        {
            var genericResponses = new List<AIContent>(resumeEntries.Count);
            foreach (var resume in resumeEntries)
            {
                if (TryDecodeToolApprovalResume(resume, jsonSerializerOptions,
                    out var approvalRequest, out var approvalResponse))
                {
                    messages.Add(new ChatMessage(ChatRole.Assistant, [approvalRequest!]));
                    messages.Add(new ChatMessage(ChatRole.User, [approvalResponse!]));
                    continue;
                }

                genericResponses.Add(new InterruptResponseContent(resume.InterruptId)
                {
                    Payload = resume.Payload,
                    Metadata = resume.Metadata,
                });
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

        var isContinuation = ConfigureForMixedInvocation(chatOptions, clientTools, clientToolNames, messages);

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
        out ToolApprovalResponseContent? response)
    {
        request = null;
        response = null;

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
        return true;
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
        List<ChatMessage> chatMessages)
    {
        if (clientTools is not { Count: > 0 })
        {
            return false;
        }

        if (TryGetClientToolResults(chatMessages, clientToolNames, out var clientCallResults))
        {
            ProcessContinuation(chatOptions, clientTools, clientToolNames, chatMessages, clientCallResults);
            return true;
        }

        // First turn: wrap every invocable client proxy in ApprovalRequiredAIFunction.
        // When FICC sees any client proxy called, it converts the complete call batch to
        // ToolApprovalRequestContent and terminates before any server peer executes.
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            chatOptions.Tools.Add(new ApprovalRequiredAIFunction((AIFunction)tool));
        }

        return false;
    }

    private static bool TryGetClientToolResults(
        List<ChatMessage> messages,
        HashSet<string> clientToolNames,
        out Dictionary<string, FunctionResultContent> clientCallResults)
    {
        clientCallResults = new Dictionary<string, FunctionResultContent>(StringComparer.Ordinal);
        var assistantCallIndex = -1;
        var clientCallIds = new HashSet<string>(StringComparer.Ordinal);

        for (var i = messages.Count - 1; i >= 0; i--)
        {
            foreach (var content in messages[i].Contents)
            {
                if (content is FunctionCallContent fcc && clientToolNames.Contains(fcc.Name))
                {
                    clientCallIds.Add(fcc.CallId);
                    assistantCallIndex = i;
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

        // A continuation ends with results/approval responses for the latest client-tool batch.
        // Any later ordinary content means that batch belongs to completed history.
        for (var i = assistantCallIndex + 1; i < messages.Count; i++)
        {
            foreach (var content in messages[i].Contents)
            {
                if (content is FunctionResultContent frc && clientCallIds.Contains(frc.CallId))
                {
                    clientCallResults[frc.CallId] = frc;
                }
                else if (content is not ToolApprovalRequestContent
                    && content is not ToolApprovalResponseContent)
                {
                    clientCallResults.Clear();
                    return false;
                }
            }
        }

        return clientCallResults.Count > 0;
    }

    private static void ProcessContinuation(
        ChatOptions chatOptions,
        IList<AITool> clientTools,
        HashSet<string> clientToolNames,
        List<ChatMessage> chatMessages,
        Dictionary<string, FunctionResultContent> clientCallResults)
    {
        var existingApprovalRequests = new List<ToolApprovalRequestContent>();
        var existingApprovalResponses = new Dictionary<string, ToolApprovalResponseContent>(StringComparer.Ordinal);
        RemoveApprovalContent(chatMessages, existingApprovalRequests, existingApprovalResponses);
        var existingApprovalRequestsByCallId = existingApprovalRequests
            .Where(request => request.ToolCall is FunctionCallContent)
            .ToDictionary(request => request.ToolCall.CallId, StringComparer.Ordinal);
        var mergedExistingApprovalCallIds = new HashSet<string>(StringComparer.Ordinal);

        // Remove the client-produced results from the reconstructed history. FICC will invoke the
        // client proxies below and recreate one provider-valid tool-result message containing both
        // those exact results and the real server results.
        RemoveClientResults(chatMessages, clientCallResults.Keys);

        // Rebuild the last mixed assistant batch as one approval request/response exchange. Client
        // calls are approved against result-returning proxies; collateral server calls are approved
        // silently and execute their real functions.
        var approvalResponses = new List<AIContent>();
        for (var i = chatMessages.Count - 1; i >= 0; i--)
        {
            var msg = chatMessages[i];
            if (msg.Role != ChatRole.Assistant
                || !msg.Contents.Any(c => c is FunctionCallContent))
            {
                continue;
            }

            var newContents = new List<AIContent>();
            foreach (var content in msg.Contents)
            {
                if (content is FunctionCallContent fcc)
                {
                    if (existingApprovalRequestsByCallId.TryGetValue(fcc.CallId, out var existingRequest))
                    {
                        newContents.Add(existingRequest);
                        mergedExistingApprovalCallIds.Add(fcc.CallId);
                        if (existingApprovalResponses.TryGetValue(existingRequest.RequestId, out var existingResponse))
                        {
                            approvalResponses.Add(existingResponse);
                        }
                        continue;
                    }

                    var request = new ToolApprovalRequestContent($"approval_{fcc.CallId}", fcc)
                    {
#pragma warning disable MEAI001
                        RequiresConfirmation = clientToolNames.Contains(fcc.Name),
#pragma warning restore MEAI001
                    };
                    newContents.Add(request);
                    approvalResponses.Add(request.CreateResponse(approved: true));
                }
                else
                {
                    newContents.Add(content);
                }
            }

            foreach (var request in existingApprovalRequests)
            {
                if (mergedExistingApprovalCallIds.Contains(request.ToolCall.CallId))
                {
                    continue;
                }

                newContents.Add(request);
                if (existingApprovalResponses.TryGetValue(request.RequestId, out var response))
                {
                    approvalResponses.Add(response);
                }
            }

            var replacement = msg.Clone();
            replacement.Contents = newContents;
            chatMessages[i] = replacement;
            break;
        }

        if (approvalResponses.Count > 0)
        {
            chatMessages.Add(new ChatMessage(ChatRole.User, approvalResponses));
        }

        // Each proxy uses FunctionInvokingChatClient.CurrentContext.CallContent.CallId, so repeated
        // calls to the same client tool receive their own exact result. Wrapping it again ensures a
        // newly-issued call stops for a fresh client execution instead of reusing stale data.
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            var proxy = new ClientResultAIFunction((AIFunctionDeclaration)tool, clientCallResults);
            chatOptions.Tools.Add(new ApprovalRequiredAIFunction(proxy));
        }
    }

    private static void RemoveApprovalContent(
        List<ChatMessage> chatMessages,
        List<ToolApprovalRequestContent> approvalRequests,
        Dictionary<string, ToolApprovalResponseContent> approvalResponses)
    {
        for (var i = chatMessages.Count - 1; i >= 0; i--)
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

        approvalRequests.Reverse();
    }

    private static void RemoveClientResults(
        List<ChatMessage> chatMessages,
        ICollection<string> clientResultCallIds)
    {
        for (var i = chatMessages.Count - 1; i >= 0; i--)
        {
            var message = chatMessages[i];
            var retainedContents = new List<AIContent>(message.Contents.Count);

            foreach (var content in message.Contents)
            {
                if (content is FunctionResultContent frc && clientResultCallIds.Contains(frc.CallId))
                {
                    continue;
                }

                retainedContents.Add(content);
            }

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
