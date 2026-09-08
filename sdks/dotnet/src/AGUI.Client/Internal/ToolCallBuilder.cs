using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Client;

internal sealed class ToolCallBuilder
{
    private readonly Dictionary<string, ToolCallState> _activeToolCalls = new();
    private readonly HashSet<string> _pendingToolCallIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ChatResponseUpdate> _heldCalls = new(StringComparer.Ordinal);
    private readonly List<string> _heldCallOrder = new();
    private readonly HashSet<string> _yieldedCallIds = new(StringComparer.Ordinal);
    private readonly List<ChatResponseUpdate> _buffer = new();

    // callId -> the message id the TypeScript reducer mints for the assistant message
    // carrying that call (parentMessageId ?? toolCallId). Kept for the whole run: a
    // call-scoped REASONING_ENCRYPTED_VALUE can arrive after the call flushed, and its
    // update must join the same coalesced message.
    private readonly Dictionary<string, string> _mintedMessageIds = new(StringComparer.Ordinal);
    private string? _conversationId;
    private string? _responseId;

    public bool IsBuffering => _pendingToolCallIds.Count > 0;

    public void SetIds(string? conversationId, string? responseId)
    {
        _conversationId = conversationId;
        _responseId = responseId;
    }

    public void StartToolCall(ToolCallStartEvent evt)
    {
        if (_activeToolCalls.ContainsKey(evt.ToolCallId))
        {
            throw new InvalidOperationException(
                $"Cannot send 'TOOL_CALL_START' event: A tool call with ID '{evt.ToolCallId}' is already in progress. Complete it with 'TOOL_CALL_END' first.");
        }

        // string.IsNullOrEmpty, not ??: the TypeScript reducer's fallback is a
        // TRUTHINESS check (`if (parentMessageId)`), so an empty-string parent —
        // which this SDK's own server emits for unset optionals on some paths —
        // mints the toolCallId there. Keeping "" here put an empty messageId on
        // the update and split the coalesced message (caught by the hosting
        // baseline snapshots).
        var mintedParent = string.IsNullOrEmpty(evt.ParentMessageId) ? null : evt.ParentMessageId;
        _activeToolCalls[evt.ToolCallId] = new ToolCallState(evt.ToolCallName, mintedParent);
        _mintedMessageIds[evt.ToolCallId] = mintedParent ?? evt.ToolCallId;
    }

    public void AppendArgs(ToolCallArgsEvent evt)
    {
        if (!_activeToolCalls.TryGetValue(evt.ToolCallId, out var state))
        {
            throw new InvalidOperationException(
                $"Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID '{evt.ToolCallId}'. Start a tool call with 'TOOL_CALL_START' first.");
        }

        state.Arguments.Append(evt.Delta);
    }

    public ChatResponseUpdate EndToolCall(ToolCallEndEvent evt, JsonSerializerOptions jsonSerializerOptions)
    {
        if (!_activeToolCalls.TryGetValue(evt.ToolCallId, out var state))
        {
            throw new InvalidOperationException(
                $"Cannot send 'TOOL_CALL_END' event: No active tool call found with ID '{evt.ToolCallId}'. A 'TOOL_CALL_START' event must be sent first.");
        }

        _activeToolCalls.Remove(evt.ToolCallId);

        var functionCall = new FunctionCallContent(
            callId: evt.ToolCallId,
            name: state.Name,
            arguments: DeserializeArguments(state.Arguments.ToString(), jsonSerializerOptions));

        var update = new ChatResponseUpdate(ChatRole.Assistant, [functionCall])
        {
            ConversationId = _conversationId,
            ResponseId = _responseId,
            // The id the TypeScript reducer mints for the assistant message carrying
            // this call (parentMessageId ?? toolCallId). Required for more than
            // parity: ToChatResponse merges an update's AdditionalProperties into the
            // CURRENT MESSAGE only when the update carries a message identity — an
            // id-less update's properties are hoisted onto the ChatResponse, so a
            // delegation whose output is only tool activity lost its attribution on
            // the way back out through AsAGUIMessages.
            MessageId = state.ParentMessageId ?? evt.ToolCallId,
            CreatedAt = DateTimeOffset.UtcNow,
            RawRepresentation = evt
        };

        _pendingToolCallIds.Add(evt.ToolCallId);
        _heldCalls[evt.ToolCallId] = update;
        _heldCallOrder.Add(evt.ToolCallId);
        return update;
    }

    public void MarkCallYielded(string toolCallId) => _yieldedCallIds.Add(toolCallId);

    /// <summary>
    /// The message id minted for the assistant message carrying <paramref name="toolCallId"/>,
    /// or null when the call was never started in this run.
    /// </summary>
    public string? MintedMessageIdFor(string toolCallId) =>
        _mintedMessageIds.TryGetValue(toolCallId, out var id) ? id : null;

    public IReadOnlyList<ChatResponseUpdate> AddResult(string toolCallId, ChatResponseUpdate resultUpdate)
    {
        _pendingToolCallIds.Remove(toolCallId);

        var flushed = new List<ChatResponseUpdate>();
        if (_heldCalls.TryGetValue(toolCallId, out var callUpdate))
        {
            _heldCalls.Remove(toolCallId);
            _heldCallOrder.Remove(toolCallId);
            if (!_yieldedCallIds.Contains(toolCallId))
            {
                flushed.Add(callUpdate);
            }
        }

        flushed.Add(resultUpdate);

        if (_pendingToolCallIds.Count == 0)
        {
            flushed.AddRange(_buffer);
            _buffer.Clear();
        }

        return flushed;
    }

    public void BufferUpdate(ChatResponseUpdate update)
    {
        _buffer.Add(update);
    }

    public IReadOnlyList<ChatResponseUpdate> FlushAsToolCalls()
    {
        if (_heldCalls.Count == 0 && _buffer.Count == 0)
        {
            return Array.Empty<ChatResponseUpdate>();
        }

        var flushed = new List<ChatResponseUpdate>();
        foreach (var toolCallId in _heldCallOrder)
        {
            if (_heldCalls.TryGetValue(toolCallId, out var update)
                && !_yieldedCallIds.Contains(toolCallId))
            {
                flushed.Add(update);
            }
        }

        flushed.AddRange(_buffer);
        _buffer.Clear();
        _heldCalls.Clear();
        _heldCallOrder.Clear();
        _pendingToolCallIds.Clear();
        return flushed;
    }

    public IReadOnlyList<ChatResponseUpdate> FlushWithInterrupts(
        RunFinishedInterruptOutcome interruptOutcome)
    {
        if (_heldCalls.Count == 0 && _buffer.Count == 0)
        {
            return Array.Empty<ChatResponseUpdate>();
        }

        // Build a map of interrupted toolCallIds to their interrupt
        var interruptById = new Dictionary<string, AGUIInterrupt>(StringComparer.Ordinal);
        foreach (var interrupt in interruptOutcome.Interrupts)
        {
            if (string.Equals(interrupt.Reason, InterruptReasons.ToolCall, StringComparison.OrdinalIgnoreCase)
                && interrupt.ToolCallId is not null)
            {
                interruptById[interrupt.ToolCallId] = interrupt;
            }
        }

        var updates = new List<ChatResponseUpdate>();
        foreach (var toolCallId in _heldCallOrder)
        {
            if (!_heldCalls.TryGetValue(toolCallId, out var update))
            {
                continue;
            }

            if (update.Contents.Count == 1
                && update.Contents[0] is FunctionCallContent fcc
                && interruptById.TryGetValue(fcc.CallId, out var interrupt))
            {
                // This tool call is interrupted — emit ToolApprovalRequestContent.
                // The call update itself may already have been yielded at TOOL_CALL_END
                // so a UI can show the in-progress call; this replacement is the HITL
                // signal and must still be produced.
                var approvalRequest = new ToolApprovalRequestContent(
                    interrupt.Id, fcc)
                {
                    RawRepresentation = interrupt,
                };

                updates.Add(new ChatResponseUpdate(ChatRole.Assistant, [approvalRequest])
                {
                    ConversationId = update.ConversationId,
                    ResponseId = update.ResponseId,
                    // The held call update's message identity must survive the
                    // replacement, or the coalescer hoists this update's attribution
                    // onto the ChatResponse and the approval comes back parent-owned
                    // (see EndToolCall).
                    MessageId = update.MessageId,
                    CreatedAt = update.CreatedAt,
                    RawRepresentation = update.RawRepresentation
                });
            }
            else if (!_yieldedCallIds.Contains(toolCallId))
            {
                updates.Add(update);
            }
        }

        updates.AddRange(_buffer);
        _buffer.Clear();
        _heldCalls.Clear();
        _heldCallOrder.Clear();
        _pendingToolCallIds.Clear();
        return updates;
    }

    public void EnsureCompleted()
    {
        if (_activeToolCalls.Count > 0)
        {
            throw new InvalidOperationException(
                $"Cannot send 'RUN_FINISHED' while tool calls are still active: {string.Join(", ", _activeToolCalls.Keys)}");
        }
    }

    public void Reset()
    {
        _activeToolCalls.Clear();
        _pendingToolCallIds.Clear();
        _heldCalls.Clear();
        _heldCallOrder.Clear();
        _yieldedCallIds.Clear();
        _buffer.Clear();
        // Minted identities are per run like everything else here: entity ids are
        // run-global, so a later run reusing a call id must not coalesce its
        // call-scoped encrypted values under the previous run's parent message.
        _mintedMessageIds.Clear();
    }

    private static IDictionary<string, object?>? DeserializeArguments(string argsJson, JsonSerializerOptions options)
    {
        if (string.IsNullOrEmpty(argsJson))
        {
            return null;
        }

        JsonTypeInfo typeInfo = options.GetTypeInfo(typeof(IDictionary<string, object?>));
        return (IDictionary<string, object?>?)JsonSerializer.Deserialize(argsJson, typeInfo);
    }

    private sealed class ToolCallState
    {
        public ToolCallState(string name, string? parentMessageId)
        {
            Name = name;
            ParentMessageId = parentMessageId;
        }

        public string Name { get; }

        public string? ParentMessageId { get; }

        public StringBuilder Arguments { get; } = new();
    }
}
