using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class ToolCallEndEventExtensions
{
    extension(ToolCallEndEvent)
    {
        public static ToolCallEndEvent Create(string toolCallId, JsonElement? rawEvent = null) =>
            new() { ToolCallId = toolCallId, RawEvent = rawEvent };
    }
}
