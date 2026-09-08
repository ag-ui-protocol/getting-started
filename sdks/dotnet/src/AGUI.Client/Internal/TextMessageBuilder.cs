using System;
using System.Collections.Generic;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Client;

internal sealed class TextMessageBuilder
{
    private readonly Dictionary<string, (ChatRole Role, string? AuthorName)> _activeMessages = new();
    private string? _conversationId;
    private string? _responseId;

    public void SetConversationAndResponseIds(string? conversationId, string? responseId)
    {
        _conversationId = conversationId;
        _responseId = responseId;
    }

    public void AddTextStart(TextMessageStartEvent textStart)
    {
        var role = AGUIChatMessageExtensions.MapChatRole(textStart.Role);
        if (_activeMessages.ContainsKey(textStart.MessageId))
        {
            throw new InvalidOperationException(
                $"Cannot send 'TEXT_MESSAGE_START' event: A text message with ID '{textStart.MessageId}' is already in progress. Complete it with 'TEXT_MESSAGE_END' first.");
        }

        _activeMessages[textStart.MessageId] = (role, textStart.Name);
    }

    public ChatResponseUpdate EmitTextUpdate(TextMessageContentEvent textContent)
    {
        if (!_activeMessages.TryGetValue(textContent.MessageId, out var entry))
        {
            throw new InvalidOperationException(
                $"Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID '{textContent.MessageId}'. Start a text message with 'TEXT_MESSAGE_START' first.");
        }

        return new ChatResponseUpdate(
            entry.Role,
            textContent.Delta)
        {
            AuthorName = entry.AuthorName,
            ConversationId = _conversationId,
            ResponseId = _responseId,
            MessageId = textContent.MessageId,
            CreatedAt = DateTimeOffset.UtcNow,
            RawRepresentation = textContent
        };
    }

    public void EndCurrentMessage(TextMessageEndEvent textEnd)
    {
        if (!_activeMessages.ContainsKey(textEnd.MessageId))
        {
            throw new InvalidOperationException(
                $"Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID '{textEnd.MessageId}'. A 'TEXT_MESSAGE_START' event must be sent first.");
        }

        _activeMessages.Remove(textEnd.MessageId);
    }

    public void EnsureCompleted()
    {
        if (_activeMessages.Count > 0)
        {
            throw new InvalidOperationException(
                $"Cannot send 'RUN_FINISHED' while text messages are still active: {string.Join(", ", _activeMessages.Keys)}");
        }
    }

    public void Reset()
    {
        _activeMessages.Clear();
    }
}
