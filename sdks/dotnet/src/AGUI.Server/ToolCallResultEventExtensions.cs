using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class ToolCallResultEventExtensions
{
    extension(ToolCallResultEvent)
    {
        public static ToolCallResultEvent Create(
            string toolCallId,
            string result,
            JsonElement? rawEvent = null) =>
            new() { ToolCallId = toolCallId, MessageId = toolCallId, Content = result, RawEvent = rawEvent };
    }
}
