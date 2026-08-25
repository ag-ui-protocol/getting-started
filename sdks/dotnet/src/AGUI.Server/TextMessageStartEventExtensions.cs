using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class TextMessageStartEventExtensions
{
    extension(TextMessageStartEvent)
    {
        public static TextMessageStartEvent Create(
            string messageId,
            string role,
            string? name = null,
            JsonElement? rawEvent = null) =>
            new() { MessageId = messageId, Role = role, Name = name, RawEvent = rawEvent };
    }
}
