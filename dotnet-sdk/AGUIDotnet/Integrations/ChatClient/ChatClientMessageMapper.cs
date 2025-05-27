using System;
using System.Collections.Immutable;
using System.Text.Json;
using AGUIDotnet.Types;
using Microsoft.Extensions.AI;

namespace AGUIDotnet.Integrations.ChatClient;

public static class ChatClientMessageMapper
{
    /// <summary>
    /// Maps AGUI messages to chat client messages.
    /// </summary>
    /// <param name="agUIMessages">The <see cref="BaseMessage"/> collection to map</param>
    /// <returns>The <see cref="ChatMessage"/> collection to provide to <see cref="IChatClient"/></returns>
    /// <exception cref="NotSupportedException">An unexpected message type was encountered</exception>
    public static ImmutableList<ChatMessage> MapAGUIMessagesToChatClientMessages(
        this IEnumerable<BaseMessage> agUIMessages
    )
    {
        return [.. agUIMessages
        // Filter messages that are relevant for chat clients
        .Where(msg => msg is SystemMessage or UserMessage or AssistantMessage or ToolMessage)
        .Select(msg => msg switch
        {
            SystemMessage sys => new ChatMessage(
                role: ChatRole.System,
                content: sys.Content
            )
            {
                MessageId = sys.Id,
                AuthorName = sys.Name
            },

            UserMessage usr => new ChatMessage(
                role: ChatRole.User,
                content: usr.Content
            )
            {
                MessageId = usr.Id,
                AuthorName = usr.Name
            },

            AssistantMessage asst => new ChatMessage(
                role: ChatRole.Assistant,
                contents: [
                    .. string.IsNullOrWhiteSpace(asst.Content)
                        ? (AIContent[])[]
                        : [new TextContent(asst.Content)],
                    ..asst.ToolCalls.Select(tc => new FunctionCallContent(
                        callId: tc.Id,
                        name: tc.Function.Name,
                        arguments: JsonSerializer.Deserialize<ImmutableDictionary<string, object?>>(tc.Function.Arguments)
                    ))
                ]
            ) {
                MessageId = asst.Id,
                AuthorName = asst.Name
            },

            ToolMessage tool => new ChatMessage(
                role: ChatRole.Tool,
                contents: [
                    new FunctionResultContent(
                        callId: tool.ToolCallId,
                        result: tool.Content
                    )
                ]
            ) {
                MessageId = tool.Id,
            },

            _ => throw new NotSupportedException($"Unsupported message type: {msg.GetType()}")
        })];
    }
}
