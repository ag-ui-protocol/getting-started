using System;

namespace AGUIDotnet.Events;

public static class EventHelpers
{
    public static IEnumerable<BaseEvent> SendSimpleMessage(string message, string? messageId = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(message, nameof(message));

        messageId ??= Guid.NewGuid().ToString();

        return [
            new TextMessageStartEvent {
                MessageId = messageId,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            },

            new TextMessageContentEvent {
                MessageId = messageId,
                Delta = message,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            },

            new TextMessageEndEvent {
                MessageId = messageId,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            }
        ];
    }
}
