using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class TextMessageEndEventExtensions
{
    extension(TextMessageEndEvent)
    {
        public static TextMessageEndEvent Create(string messageId, JsonElement? rawEvent = null) =>
            new() { MessageId = messageId, RawEvent = rawEvent };
    }
}
