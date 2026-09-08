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

        if (HasClientToolResults(chatMessages, clientToolNames))
        {
            ProcessContinuation(chatOptions, clientTools, clientToolNames, chatMessages);
            return true;
        }

        // First turn: wrap client tools in ApprovalRequiredAIFunction.
        // When FICC sees any ApprovalRequired tool called, it converts ALL FCCs in the
        // response to ToolApprovalRequestContent and terminates. The stream converter
        // unwraps them back to plain TOOL_CALL events.
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            if (tool is AIFunction aiFunction)
            {
                chatOptions.Tools.Add(new ApprovalRequiredAIFunction(aiFunction));
            }
            else
            {
                chatOptions.Tools.Add(tool);
            }
        }

        return false;
    }

    private static bool HasClientToolResults(List<ChatMessage> messages, HashSet<string> clientToolNames)
    {
        var clientCallIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var message in messages)
        {
            foreach (var content in message.Contents)
            {
                if (content is FunctionCallContent fcc && clientToolNames.Contains(fcc.Name))
                {
                    clientCallIds.Add(fcc.CallId);
                }
                else if (content is FunctionResultContent frc && clientCallIds.Contains(frc.CallId))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static void ProcessContinuation(
        ChatOptions chatOptions,
        IList<AITool> clientTools,
        HashSet<string> clientToolNames,
        List<ChatMessage> chatMessages)
    {
        // Collect client tool results from messages and the set of call ids that already have a
        // result (i.e. were executed client-side).
        var clientCallResults = new Dictionary<string, string>(StringComparer.Ordinal);
        var callIdToName = new Dictionary<string, string>(StringComparer.Ordinal);
        var resolvedCallIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var message in chatMessages)
        {
            foreach (var content in message.Contents)
            {
                if (content is FunctionCallContent fcc && clientToolNames.Contains(fcc.Name))
                {
                    callIdToName[fcc.CallId] = fcc.Name;
                }
                else if (content is FunctionResultContent frc)
                {
                    resolvedCallIds.Add(frc.CallId);
                    if (callIdToName.ContainsKey(frc.CallId))
                    {
                        clientCallResults[frc.CallId] = frc.Result?.ToString() ?? string.Empty;
                    }
                }
            }
        }

        // A client tool call that already has a result is a complete tool_calls/tool exchange and
        // is left untouched so the model sees a valid history. A call that has NO result yet (a
        // server tool surfaced alongside a client tool in a mixed turn) still needs to run, so it
        // is converted to a ToolApprovalRequestContent + approved ToolApprovalResponseContent pair
        // for FunctionInvokingChatClient to resume and execute.
        var approvalResponses = new List<AIContent>();
        for (var i = chatMessages.Count - 1; i >= 0; i--)
        {
            var msg = chatMessages[i];
            if (msg.Role != ChatRole.Assistant
                || !msg.Contents.Any(c => c is FunctionCallContent { CallId: { } id } && !resolvedCallIds.Contains(id)))
            {
                continue;
            }

            var newContents = new List<AIContent>();
            foreach (var content in msg.Contents)
            {
                if (content is FunctionCallContent fcc && !resolvedCallIds.Contains(fcc.CallId))
                {
                    var request = new ToolApprovalRequestContent($"approval_{fcc.CallId}", fcc);
                    newContents.Add(request);
                    approvalResponses.Add(request.CreateResponse(approved: true));
                }
                else
                {
                    newContents.Add(content);
                }
            }

            chatMessages[i] = new ChatMessage(msg.Role, newContents);
            break; // Only process the last assistant message with unresolved tool calls
        }

        if (approvalResponses.Count > 0)
        {
            chatMessages.Add(new ChatMessage(ChatRole.User, approvalResponses));
        }

        // (Re)declare the client tools, wrapped in ApprovalRequiredAIFunction so a *new* call the
        // model makes on this continuation stops FunctionInvokingChatClient (rather than being
        // answered server-side with a stale cached value). The response mapping unwraps such a
        // client-tool approval back into a plain TOOL_CALL so the client executes it freshly. A
        // client tool that already produced a result is registered as a proxy returning that
        // result, so the *original* already-approved call still resolves server-side.
        chatOptions.Tools ??= new List<AITool>();
        foreach (var tool in clientTools)
        {
            string? result = null;
            foreach (var kvp in clientCallResults)
            {
                if (callIdToName.TryGetValue(kvp.Key, out var name) && name == tool.Name)
                {
                    result = kvp.Value;
                    break;
                }
            }

            if (result is not null)
            {
                var proxyResult = result;
                var description = (tool as AIFunction)?.Description ?? string.Empty;
                var proxy = AIFunctionFactory.Create(
                    () => proxyResult,
                    tool.Name,
                    description);
                chatOptions.Tools.Add(new ApprovalRequiredAIFunction(proxy));
            }
            else if (tool is AIFunction aiFunction)
            {
                chatOptions.Tools.Add(new ApprovalRequiredAIFunction(aiFunction));
            }
            else
            {
                chatOptions.Tools.Add(tool);
            }
        }
    }
}
