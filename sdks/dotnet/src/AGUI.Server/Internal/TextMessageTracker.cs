using System;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

internal struct TextMessageTracker
{
    private string? _currentMessageId;

    public bool IsActive => _currentMessageId is not null;

    public bool IsMessageId(string? messageId) =>
        string.Equals(_currentMessageId, messageId, StringComparison.Ordinal);

    public BaseEvent? Close(JsonElement? raw = null)
    {
        if (_currentMessageId is null)
        {
            return null;
        }

        var evt = TextMessageEndEvent.Create(_currentMessageId, raw);
        _currentMessageId = null;
        return evt;
    }

    public BaseEvent Open(string messageId, string role, string? name, JsonElement? raw)
    {
        _currentMessageId = messageId;
        return TextMessageStartEvent.Create(messageId, role, name, raw);
    }

    public BaseEvent EmitDelta(string text, JsonElement? raw)
    {
        return TextMessageContentEvent.Create(_currentMessageId!, text, raw);
    }
}
