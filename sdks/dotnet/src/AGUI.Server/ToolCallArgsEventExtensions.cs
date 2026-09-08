using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class ToolCallArgsEventExtensions
{
    extension(ToolCallArgsEvent)
    {
        public static ToolCallArgsEvent Create(
            string toolCallId,
            string delta,
            JsonElement? rawEvent = null) =>
            new() { ToolCallId = toolCallId, Delta = delta, RawEvent = rawEvent };
    }
}
