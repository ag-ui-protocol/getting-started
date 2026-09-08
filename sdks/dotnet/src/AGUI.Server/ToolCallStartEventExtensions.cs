using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class ToolCallStartEventExtensions
{
    extension(ToolCallStartEvent)
    {
        public static ToolCallStartEvent Create(
            string toolCallId,
            string toolCallName,
            string? parentMessageId = null,
            JsonElement? rawEvent = null) =>
            new()
            {
                ToolCallId = toolCallId,
                ToolCallName = toolCallName,
                ParentMessageId = parentMessageId,
                RawEvent = rawEvent
            };
    }
}
