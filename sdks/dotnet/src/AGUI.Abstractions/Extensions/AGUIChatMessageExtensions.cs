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

        foreach (var message in aguiMessages)
        {
            // Activity messages are frontend-only and are never forwarded to the agent, so a
            // client that sends one anyway is ignored rather than failing the run. Dropped
            // before the tool-call bookkeeping below so the message stays fully transparent:
            // it must not split a run of parallel tool calls that is mid-coalesce.
            if (message is AGUIActivityMessage)
            {
                continue;
            }

            if (message is AGUIAssistantMessage toolCallAssistant && toolCallAssistant.ToolCalls is { Count: > 0 })
            {
                pendingToolCallContents ??= new List<AIContent>();
                pendingToolCallId ??= message.Id;

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
                yield return new ChatMessage(ChatRole.Assistant, pendingToolCallContents) { MessageId = pendingToolCallId };
                pendingToolCallContents = null;
                pendingToolCallId = null;
            }

            // Reasoning is the model's own thinking rather than its output, and the spec has
            // clients send it back on subsequent turns. Microsoft.Extensions.AI models that as
            // TextReasoningContent on an assistant turn; encryptedValue becomes ProtectedData,
            // the opaque provider blob MEAI round-trips untouched, which is what keeps encrypted
            // chain-of-thought continuous across turns (store:false / ZDR).
            if (message is AGUIReasoningMessage reasoningMessage)
            {
                var reasoningContents = new List<AIContent>
                {
                    new TextReasoningContent(reasoningMessage.Content)
                    {
                        ProtectedData = reasoningMessage.EncryptedValue
                    }
                };

                yield return new ChatMessage(ChatRole.Assistant, reasoningContents)
                {
                    MessageId = message.Id
                };

                continue;
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

                yield return new ChatMessage(role, contents) { MessageId = message.Id, AuthorName = authorName };
            }
            else if (message is AGUIToolMessage toolMessage)
            {
                var contents = new List<AIContent>
                {
                    new FunctionResultContent(toolMessage.ToolCallId ?? string.Empty, toolMessage.Content)
                };

                yield return new ChatMessage(role, contents)
                {
                    MessageId = message.Id
                };
            }
            else
            {
                var text = message switch
                {
                    AGUIAssistantMessage assistant => assistant.Content ?? string.Empty,
                    AGUISystemMessage system => system.Content,
                    AGUIDeveloperMessage developer => developer.Content,
                    _ => string.Empty,
                };

                yield return new ChatMessage(role, text)
                {
                    MessageId = message.Id
                };
            }
        }

        // Flush any trailing assistant-tool-call run.
        if (pendingToolCallContents is not null)
        {
            yield return new ChatMessage(ChatRole.Assistant, pendingToolCallContents) { MessageId = pendingToolCallId };
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
                        Content = SerializeFunctionResult(functionResult, message.Text)
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
            yield return aguiMessage;
        }
    }

    /// <summary>
    /// Maps an AG-UI role string to a <see cref="ChatRole"/>.
    /// </summary>
    /// <param name="role">The AG-UI role string.</param>
    /// <returns>The corresponding <see cref="ChatRole"/>.</returns>
    /// <remarks>
    /// <see cref="AGUIRoles.Reasoning"/> maps to <see cref="ChatRole.Assistant"/>; the reasoning
    /// text itself is carried as <see cref="TextReasoningContent"/> by
    /// <see cref="AsChatMessages"/>. <see cref="AGUIRoles.Activity"/> has no chat-role
    /// equivalent — it is frontend-only and never forwarded to the agent, so
    /// <see cref="AsChatMessages"/> drops those messages instead of calling this method.
    /// </remarks>
    /// <exception cref="InvalidOperationException">
    /// Thrown when <paramref name="role"/> has no <see cref="ChatRole"/> equivalent.
    /// </exception>
    public static ChatRole MapChatRole(string role) =>
        string.Equals(role, AGUIRoles.System, StringComparison.OrdinalIgnoreCase) ? ChatRole.System :
        string.Equals(role, AGUIRoles.User, StringComparison.OrdinalIgnoreCase) ? ChatRole.User :
        string.Equals(role, AGUIRoles.Assistant, StringComparison.OrdinalIgnoreCase) ? ChatRole.Assistant :
        string.Equals(role, AGUIRoles.Developer, StringComparison.OrdinalIgnoreCase) ? s_developerChatRole :
        string.Equals(role, AGUIRoles.Tool, StringComparison.OrdinalIgnoreCase) ? ChatRole.Tool :
        string.Equals(role, AGUIRoles.Reasoning, StringComparison.OrdinalIgnoreCase) ? ChatRole.Assistant :
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
