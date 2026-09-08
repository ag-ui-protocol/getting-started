using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal static class TextMessageContentEventExtensions
{
    extension(TextMessageContentEvent)
    {
        public static TextMessageContentEvent Create(
            string messageId,
            string delta,
            JsonElement? rawEvent = null) =>
            new() { MessageId = messageId, Delta = delta, RawEvent = rawEvent };
    }
}
