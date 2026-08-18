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
    private readonly List<ChatResponseUpdate> _buffer = new();
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

        _activeToolCalls[evt.ToolCallId] = new ToolCallState(evt.ToolCallName);
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

    public void EndToolCall(ToolCallEndEvent evt, JsonSerializerOptions jsonSerializerOptions)
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

        _pendingToolCallIds.Add(evt.ToolCallId);
        _buffer.Add(new ChatResponseUpdate(ChatRole.Assistant, [functionCall])
        {
            ConversationId = _conversationId,
            ResponseId = _responseId,
            CreatedAt = DateTimeOffset.UtcNow,
            RawRepresentation = evt
        });
    }

    public IReadOnlyList<ChatResponseUpdate> AddResult(string toolCallId, ChatResponseUpdate resultUpdate)
    {
        _pendingToolCallIds.Remove(toolCallId);
        _buffer.Add(resultUpdate);

        if (_pendingToolCallIds.Count == 0)
        {
            var flushed = new List<ChatResponseUpdate>(_buffer);
            _buffer.Clear();
            return flushed;
        }

        return Array.Empty<ChatResponseUpdate>();
    }

    public void BufferUpdate(ChatResponseUpdate update)
    {
        _buffer.Add(update);
    }

    public IReadOnlyList<ChatResponseUpdate> FlushAsToolCalls()
    {
        if (_buffer.Count == 0)
        {
            return Array.Empty<ChatResponseUpdate>();
        }

        var flushed = new List<ChatResponseUpdate>(_buffer);
        _buffer.Clear();
        _pendingToolCallIds.Clear();
        return flushed;
    }

    public IReadOnlyList<ChatResponseUpdate> FlushWithInterrupts(
        RunFinishedInterruptOutcome interruptOutcome,
        ISet<string>? clientToolNames)
    {
        if (_buffer.Count == 0)
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
        var hasToolApprovalInterrupt = interruptById.Count > 0;

        var updates = new List<ChatResponseUpdate>(_buffer.Count);
        foreach (var update in _buffer)
        {
            if (update.Contents.Count == 1
                && update.Contents[0] is FunctionCallContent fcc
                && interruptById.TryGetValue(fcc.CallId, out var interrupt))
            {
                // This tool call is interrupted — replace with ToolApprovalRequestContent
                var approvalRequest = new ToolApprovalRequestContent(
                    interrupt.Id, fcc)
                {
                    RawRepresentation = interrupt,
                };

                updates.Add(new ChatResponseUpdate(ChatRole.Assistant, [approvalRequest])
                {
                    ConversationId = update.ConversationId,
                    ResponseId = update.ResponseId,
                    CreatedAt = update.CreatedAt,
                    RawRepresentation = update.RawRepresentation
                });
            }
            else if (update.Contents.Count == 1
                && update.Contents[0] is FunctionCallContent peerCall
                && hasToolApprovalInterrupt)
            {
                if (clientToolNames?.Contains(peerCall.Name) is not true)
                {
                    peerCall.InformationalOnly = true;
                }

                var approvalRequest = new ToolApprovalRequestContent(
                    $"approval_{peerCall.CallId}", peerCall)
                {
#pragma warning disable MEAI001
                    RequiresConfirmation = false,
#pragma warning restore MEAI001
                    RawRepresentation = update.RawRepresentation,
                };

                updates.Add(new ChatResponseUpdate(ChatRole.Assistant, [approvalRequest])
                {
                    ConversationId = update.ConversationId,
                    ResponseId = update.ResponseId,
                    CreatedAt = update.CreatedAt,
                    RawRepresentation = update.RawRepresentation
                });
            }
            else
            {
                updates.Add(update);
            }
        }

        _buffer.Clear();
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
        _buffer.Clear();
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
        public ToolCallState(string name)
        {
            Name = name;
        }

        public string Name { get; }

        public StringBuilder Arguments { get; } = new();
    }
}
