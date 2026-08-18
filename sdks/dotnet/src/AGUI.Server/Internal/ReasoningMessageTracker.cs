using System.Collections.Generic;
using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.Server;

internal sealed class ReasoningMessageTracker
{
    private string? _phaseMessageId;
    private string? _currentMessageId;
    private string? _pendingMessageId;

    public bool IsActive => _phaseMessageId is not null;

    public IEnumerable<BaseEvent> Open()
    {
        var messageId = _currentMessageId ?? _pendingMessageId ?? AGUIIdGenerator.NewMessageId();
        _pendingMessageId = null;

        if (_phaseMessageId is null)
        {
            _phaseMessageId = messageId;
            yield return new ReasoningStartEvent { MessageId = messageId };
        }

        if (_currentMessageId is null)
        {
            _currentMessageId = messageId;
            yield return new ReasoningMessageStartEvent { MessageId = messageId };
        }
    }

    public BaseEvent EmitDelta(string delta) =>
        new ReasoningMessageContentEvent
        {
            MessageId = _currentMessageId!,
            Delta = delta
        };

    public BaseEvent EmitEncryptedValue(string encryptedValue, JsonElement raw) =>
        new ReasoningEncryptedValueEvent
        {
            Subtype = "message",
            EntityId = GetMessageIdForEncryptedValue(),
            EncryptedValue = encryptedValue,
            RawEvent = raw,
        };

    public IEnumerable<BaseEvent> Close()
    {
        _pendingMessageId = null;

        if (_currentMessageId is { } messageId)
        {
            _currentMessageId = null;
            yield return new ReasoningMessageEndEvent { MessageId = messageId };
        }

        if (_phaseMessageId is { } phaseId)
        {
            _phaseMessageId = null;
            yield return new ReasoningEndEvent { MessageId = phaseId };
        }
    }

    private string GetMessageIdForEncryptedValue()
    {
        if (_currentMessageId is not null)
        {
            return _currentMessageId;
        }

        return _pendingMessageId ??= AGUIIdGenerator.NewMessageId();
    }
}
