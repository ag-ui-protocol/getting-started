using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace AGUI.Abstractions;

/// <summary>
/// Extension methods for converting between AG-UI messages and <see cref="ChatMessage"/> instances.
/// </summary>
public static class AGUIChatMessageExtensions
{
    private static readonly ChatRole s_developerChatRole = new("developer");

    /// <summary>
    /// <see cref="ChatMessage.AdditionalProperties"/> key carrying <see
    /// cref="AGUIMessage.SubagentRunId"/> across the round trip.
    /// <see cref="ChatMessage"/> has no concept of delegated work, and AGUIChatClient
    /// sends request messages through <see cref="AsAGUIMessages"/>, so without this a
    /// subagent-attributed message handed back to the client silently returns to the
    /// agent as the parent's on the next turn. Same approach the binary content parts
    /// already use for their AG-UI-only "filename".
    /// </summary>
    private const string SubagentRunIdKey = "agui.subagentRunId";

    private static ChatMessage WithSubagentRunId(ChatMessage message, string? subagentRunId)
    {
        if (subagentRunId is not null)
        {
            message.AdditionalProperties ??= new AdditionalPropertiesDictionary();
            message.AdditionalProperties[SubagentRunIdKey] = subagentRunId;
        }

        return message;
    }

    /// <summary>
    /// Converts a sequence of <see cref="AGUIMessage"/> instances to <see cref="ChatMessage"/> instances.
    /// </summary>
    /// <param name="aguiMessages">The AG-UI messages to convert.</param>
    /// <returns>A sequence of <see cref="ChatMessage"/> instances.</returns>
    public static IEnumerable<ChatMessage> AsChatMessages(this IEnumerable<AGUIMessage> aguiMessages)
    {
        // Accumulates a run of consecutive assistant messages that carry tool calls. Clients such
        // as @ag-ui/client split a single parallel-tool-call turn into one assistant message per
        // call, producing assistant(call_1), assistant(call_2), tool(call_1), tool(call_2).
        // Providers (e.g. OpenAI) reject that: an assistant tool_calls message must be immediately
        // followed by its tool results. Merging the run back into a single assistant message keeps
        // the reconstructed history valid. Only the current run is buffered, so this stays cheap.
        List<AIContent>? pendingToolCallContents = null;
        string? pendingToolCallId = null;
        // The buffered run's owner — the FIRST owner in the run.
        //
        // Parallel tool calls from DIFFERENT subagents lose the second owner here, because
        // AG-UI attributes per message and this merges the run into one ChatMessage.
        //
        // That is a current limitation, NOT an inherent conflict. The provider constraint
        // (microsoft/agent-framework#2699) is ADJACENCY — each assistant tool_calls message
        // must be immediately followed by the results for its own call ids — and merging is
        // only one way to satisfy it. Interleaving satisfies it too, and is in fact the
        // shape that issue names as correct:
        //   assistant(tc1), tool(tc1), assistant(tc2), tool(tc2)
        // which would also preserve per-message attribution.
        //
        // Splitting the run on owner change was implemented and reverted because it split
        // WITHOUT reordering the results, producing
        // assistant(tc1), assistant(tc2), tool(tc1), tool(tc2) — the exact invalid shape.
        // Doing it properly means interleaving, which changes this method's output for
        // non-subagent parallel calls as well, so it is a deliberate decision rather than a
        // drive-by fix. PNI-293 carries the analysis.
        string? pendingToolCallSubagentRunId = null;
        // Whether the run's owner has been captured yet. A separate flag rather than
        // "pendingToolCallSubagentRunId is still null", because the PARENT is an owner too
        // and its owner IS null: capturing the first non-null value promoted a later
        // subagent onto a run the parent opened, attributing the parent's own tool call to
        // it.
        var pendingToolCallOwnerCaptured = false;

        foreach (var message in aguiMessages)
        {
            if (message is AGUIAssistantMessage toolCallAssistant && toolCallAssistant.ToolCalls is { Count: > 0 })
            {
                pendingToolCallContents ??= new List<AIContent>();
                pendingToolCallId ??= message.Id;
                // First owner in the run wins, whoever that is. Splitting the run when the
                // owner changes was tried and reverted: see the note on
                // pendingToolCallSubagentRunId.
                if (!pendingToolCallOwnerCaptured)
                {
                    pendingToolCallSubagentRunId = message.SubagentRunId;
                    pendingToolCallOwnerCaptured = true;
                }

                if (!string.IsNullOrEmpty(toolCallAssistant.Content))
                {
                    pendingToolCallContents.Add(new TextContent(toolCallAssistant.Content));
                }

                foreach (var toolCall in toolCallAssistant.ToolCalls)
                {
                    pendingToolCallContents.Add(new FunctionCallContent(
                        toolCall.Id,
                        toolCall.Function.Name,
                        toolCall.Function.Arguments is { Length: > 0 }
                            ? (IDictionary<string, object?>?)JsonSerializer.Deserialize(
                                toolCall.Function.Arguments,
                                AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!)
                            : null));
                }

                continue;
            }

            // Any non-(assistant-with-tool-calls) message ends the current run; flush it first.
            if (pendingToolCallContents is not null)
            {
                yield return WithSubagentRunId(
                    new ChatMessage(ChatRole.Assistant, pendingToolCallContents) { MessageId = pendingToolCallId },
                    pendingToolCallSubagentRunId);
                pendingToolCallContents = null;
                pendingToolCallId = null;
                pendingToolCallSubagentRunId = null;
                pendingToolCallOwnerCaptured = false;
            }

            var role = MapChatRole(message.Role);

            if (message is AGUIUserMessage userMessage && userMessage.Content.Count > 0)
            {
                var authorName = userMessage.Name;
                var contents = new List<AIContent>();
                foreach (var inputContent in userMessage.Content)
                {
                    switch (inputContent)
                    {
                        case AGUITextInputContent textInput:
                            contents.Add(new TextContent(textInput.Text));
                            break;
                        case AGUIBinaryInputContent binaryInput:
                            if (binaryInput.Url is not null)
                            {
                                var uriContent = new UriContent(new Uri(binaryInput.Url), binaryInput.MimeType);
                                if (binaryInput.Filename is not null)
                                {
                                    uriContent.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                                    uriContent.AdditionalProperties["filename"] = binaryInput.Filename;
                                }

                                contents.Add(uriContent);
                            }
                            else if (binaryInput.Data is not null)
                            {
                                var bytes = Convert.FromBase64String(binaryInput.Data);
                                var dataContent = new DataContent(bytes, binaryInput.MimeType);
                                if (binaryInput.Filename is not null)
                                {
                                    dataContent.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                                    dataContent.AdditionalProperties["filename"] = binaryInput.Filename;
                                }

                                contents.Add(dataContent);
                            }

                            break;
                    }
                }

                yield return WithSubagentRunId(
                    new ChatMessage(role, contents) { MessageId = message.Id, AuthorName = authorName },
                    message.SubagentRunId);
            }
            else if (message is AGUIToolMessage toolMessage)
            {
                var contents = new List<AIContent>
                {
                    new FunctionResultContent(toolMessage.ToolCallId ?? string.Empty, toolMessage.Content)
                };

                yield return WithSubagentRunId(
                    new ChatMessage(role, contents) { MessageId = message.Id },
                    message.SubagentRunId);
            }
            else
            {
                var text = message switch
                {
                    AGUIAssistantMessage assistant => assistant.Content ?? string.Empty,
                    AGUISystemMessage system => system.Content,
                    AGUIDeveloperMessage developer => developer.Content,
                    AGUIReasoningMessage reasoning => reasoning.Content,
                    _ => string.Empty,
                };

                yield return WithSubagentRunId(
                    new ChatMessage(role, text) { MessageId = message.Id },
                    message.SubagentRunId);
            }
        }

        // Flush any trailing assistant-tool-call run.
        if (pendingToolCallContents is not null)
        {
            yield return WithSubagentRunId(
                new ChatMessage(ChatRole.Assistant, pendingToolCallContents) { MessageId = pendingToolCallId },
                pendingToolCallSubagentRunId);
        }
    }

    /// <summary>
    /// Converts a sequence of <see cref="ChatMessage"/> instances to <see cref="AGUIMessage"/> instances.
    /// </summary>
    /// <param name="chatMessages">The chat messages to convert.</param>
    /// <returns>A sequence of <see cref="AGUIMessage"/> instances.</returns>
    public static IEnumerable<AGUIMessage> AsAGUIMessages(this IEnumerable<ChatMessage> chatMessages)
    {
        foreach (var message in chatMessages)
        {
            AGUIMessage aguiMessage;
            if (message.Role == ChatRole.User)
            {
                var userMsg = new AGUIUserMessage { Name = message.AuthorName };
                var parts = new List<AGUIInputContent>();
                foreach (var content in message.Contents)
                {
                    switch (content)
                    {
                        case TextContent textContent:
                            parts.Add(new AGUITextInputContent { Text = textContent.Text ?? string.Empty });
                            break;
                        case DataContent dataContent:
                            parts.Add(new AGUIBinaryInputContent
                            {
                                MimeType = dataContent.MediaType ?? string.Empty,
                                Data = dataContent.Data is { Length: > 0 } ? Convert.ToBase64String(dataContent.Data.ToArray()) : null,
                                Filename = dataContent.AdditionalProperties?.TryGetValue("filename", out string? fn) == true ? fn : null
                            });
                            break;
                        case UriContent uriContent:
                            parts.Add(new AGUIBinaryInputContent
                            {
                                MimeType = uriContent.MediaType ?? string.Empty,
                                Url = uriContent.Uri?.ToString(),
                                Filename = uriContent.AdditionalProperties?.TryGetValue("filename", out string? fn2) == true ? fn2 : null
                            });
                            break;
                        default:
                            parts.Add(new AGUITextInputContent { Text = content.ToString() ?? string.Empty });
                            break;
                    }
                }

                userMsg.Content = parts;
                aguiMessage = userMsg;
            }
            else if (message.Role == ChatRole.Assistant)
            {
                var functionCalls = message.Contents.OfType<FunctionCallContent>().ToList();
                var assistantMsg = new AGUIAssistantMessage
                {
                    Content = string.IsNullOrEmpty(message.Text) ? null : message.Text
                };
                if (functionCalls.Count > 0)
                {
                    assistantMsg.ToolCalls = new List<AGUIToolCall>();
                    foreach (var fc in functionCalls)
                    {
                        assistantMsg.ToolCalls.Add(new AGUIToolCall
                        {
                            Id = fc.CallId ?? string.Empty,
                            Type = "function",
                            Function = new AGUIToolCallFunction
                            {
                                Name = fc.Name ?? string.Empty,
                                Arguments = fc.Arguments is not null
                                    ? JsonSerializer.Serialize(
                                        fc.Arguments,
                                        AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!)
                                    : string.Empty
                            }
                        });
                    }
                }

                aguiMessage = assistantMsg;
            }
            else if (message.Role == ChatRole.System)
            {
                aguiMessage = new AGUISystemMessage { Content = message.Text ?? string.Empty };
            }
            else if (message.Role == s_developerChatRole)
            {
                aguiMessage = new AGUIDeveloperMessage { Content = message.Text ?? string.Empty };
            }
            else if (message.Role == ChatRole.Tool)
            {
                // Mirror Microsoft.Extensions.AI (OpenAIChatClient.ToOpenAIChatMessages): a tool
                // message is materialized only from FunctionResultContent items, each keyed on its
                // tool call id. MEAI batches parallel tool results into a single tool ChatMessage,
                // so emit one AGUIToolMessage per result to preserve them all. Any tool-role content
                // without a FunctionResultContent has no tool call id to attach to and is ignored,
                // rather than synthesizing a message with an empty toolCallId.
                foreach (var functionResult in message.Contents.OfType<FunctionResultContent>())
                {
                    yield return new AGUIToolMessage
                    {
                        Id = functionResult.CallId,
                        ToolCallId = functionResult.CallId,
                        Content = SerializeFunctionResult(functionResult, message.Text),
                        // Restored here as well as at the end of the loop: this branch
                        // yields directly (one message per result) and so never reaches
                        // the shared Id/SubagentRunId assignment below.
                        SubagentRunId =
                            message.AdditionalProperties?.TryGetValue(SubagentRunIdKey, out string? toolSubagentRunId) == true
                                ? toolSubagentRunId
                                : null,
                    };
                }

                continue;
            }
            else
            {
                aguiMessage = new AGUIUserMessage
                {
                    Content = [new AGUITextInputContent { Text = message.Text ?? string.Empty }]
                };
            }

            aguiMessage.Id = message.MessageId;
            // Null-only, not IsNullOrEmpty: an empty string is a valid opaque id that the
            // schemas accept, and treating it as absent silently converted it to parent
            // attribution on the next turn.
            if (message.AdditionalProperties?.TryGetValue(SubagentRunIdKey, out string? subagentRunId) == true
                && subagentRunId is not null)
            {
                aguiMessage.SubagentRunId = subagentRunId;
            }

            yield return aguiMessage;
        }
    }

    /// <summary>
    /// Maps an AG-UI role string to a <see cref="ChatRole"/>.
    /// </summary>
    /// <param name="role">The AG-UI role string.</param>
    /// <returns>The corresponding <see cref="ChatRole"/>.</returns>
    public static ChatRole MapChatRole(string role) =>
        string.Equals(role, AGUIRoles.System, StringComparison.OrdinalIgnoreCase) ? ChatRole.System :
        string.Equals(role, AGUIRoles.User, StringComparison.OrdinalIgnoreCase) ? ChatRole.User :
        string.Equals(role, AGUIRoles.Assistant, StringComparison.OrdinalIgnoreCase) ? ChatRole.Assistant :
        string.Equals(role, AGUIRoles.Developer, StringComparison.OrdinalIgnoreCase) ? s_developerChatRole :
        string.Equals(role, AGUIRoles.Tool, StringComparison.OrdinalIgnoreCase) ? ChatRole.Tool :
        throw new InvalidOperationException($"Unknown chat role: {role}");

    private static string SerializeFunctionResult(FunctionResultContent functionResult, string? fallbackText)
    {
        switch (functionResult.Result)
        {
            case string stringResult:
                return stringResult;
            case JsonElement jsonElement:
                return jsonElement.GetRawText();
            case IDictionary<string, object?>:
                return JsonSerializer.Serialize(
                    functionResult.Result,
                    AGUIJsonSerializerContext.Default.GetTypeInfo(typeof(IDictionary<string, object?>))!);
            case not null:
                var resultTypeInfo = AGUIJsonSerializerContext.Default.GetTypeInfo(functionResult.Result.GetType());
                return resultTypeInfo is not null
                    ? JsonSerializer.Serialize(functionResult.Result, resultTypeInfo)
                    : functionResult.Result.ToString() ?? string.Empty;
            default:
                return fallbackText ?? string.Empty;
        }
    }
}
