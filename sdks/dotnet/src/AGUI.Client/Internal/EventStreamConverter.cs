using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Client;

internal static class EventStreamConverter
{
    /// <summary>
    /// Converts an AG-UI event stream to <see cref="ChatResponseUpdate"/>s, stamping each
    /// one with the subagent that produced it.
    /// </summary>
    /// <remarks>
    /// The attribution is carried in <see cref="ChatResponseUpdate.AdditionalProperties"/>
    /// under the same key <c>AsChatMessages</c> uses, because
    /// <see cref="ChatResponseExtensions.ToChatResponse"/> preserves it onto the coalesced
    /// <see cref="ChatMessage"/>. Without this the request direction was covered but the
    /// response direction was not: AGUIChatClient.GetResponseAsync builds its response
    /// from these updates, so a message a subagent produced came back untagged and the
    /// next turn sent it to the agent as the parent's.
    ///
    /// Done in one wrapper rather than at each of the ten update sites so a new site
    /// cannot silently omit it.
    /// </remarks>
    internal static async IAsyncEnumerable<ChatResponseUpdate> AsChatResponseUpdates(
        IAsyncEnumerable<BaseEvent> events,
        JsonSerializerOptions jsonSerializerOptions,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // messageId -> owner, learned from whichever event opened or created it. The
        // builders emit updates keyed by MessageId, and continuation events carry the tag
        // too, so either source resolves the owner.
        var owners = new Dictionary<string, string>(StringComparer.Ordinal);

        await foreach (var update in AsChatResponseUpdatesCore(events, jsonSerializerOptions, cancellationToken)
            .ConfigureAwait(false))
        {
            if (update.RawRepresentation is BaseEvent sourceEvent)
            {
                var (entityId, subagentId) = DescribeAttribution(sourceEvent);
                if (entityId is not null && subagentId is not null)
                {
                    owners[entityId] = subagentId;
                }
            }

            if (update.MessageId is { Length: > 0 } messageId
                && owners.TryGetValue(messageId, out var owner))
            {
                update.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                update.AdditionalProperties[AGUISubagentIdKey] = owner;
            }

            yield return update;
        }
    }

    /// <summary>
    /// Key matching <c>AGUIChatMessageExtensions</c>, so an update's attribution survives
    /// into <see cref="ChatMessage.AdditionalProperties"/> and back out through
    /// <c>AsAGUIMessages</c> on the next turn.
    /// </summary>
    private const string AGUISubagentIdKey = "agui.subagentId";

    /// <summary>Entity id and owner for the events that carry message-level attribution.</summary>
    private static (string? EntityId, string? SubagentId) DescribeAttribution(BaseEvent evt) => evt switch
    {
        TextMessageStartEvent e => (e.MessageId, e.SubagentId),
        TextMessageContentEvent e => (e.MessageId, e.SubagentId),
        TextMessageEndEvent e => (e.MessageId, e.SubagentId),
        ToolCallResultEvent e => (e.MessageId, e.SubagentId),
        ReasoningMessageStartEvent e => (e.MessageId, e.SubagentId),
        ReasoningMessageContentEvent e => (e.MessageId, e.SubagentId),
        ActivitySnapshotEvent e => (e.MessageId, e.SubagentId),
        _ => (null, null),
    };

    private static async IAsyncEnumerable<ChatResponseUpdate> AsChatResponseUpdatesCore(
        IAsyncEnumerable<BaseEvent> events,
        JsonSerializerOptions jsonSerializerOptions,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        string? conversationId = null;
        string? responseId = null;
        var textMessageBuilder = new TextMessageBuilder();
        var toolCallBuilder = new ToolCallBuilder();

        // Event verification state
        var activeSteps = new HashSet<string>();
        // Subagents open right now, mapped to the parent that spawned them (null for one
        // the parent run started directly). Nesting is tracked by this identity link, not
        // by the order events arrive in, so interleaved parallel subagents cannot swap
        // parents.
        var activeSubagents = new Dictionary<string, string?>();
        // Ids closed by a terminal in this run. Needed because "no duplicate
        // SUBAGENT_STARTED for the same id" holds for the whole run — a subagentId is a
        // unique handle for ONE invocation — so tracking only the active set would make
        // STARTED(s1)/FINISHED(s1)/STARTED(s1) legal. Deliberately NOT used to reject
        // later events tagged with a closed id: requiring a tag to name a still-live
        // subagent was explicitly rejected in the design so attribution-only producers
        // stay valid, and TypeScript accepts those streams too. Cleared per run.
        var closedSubagents = new HashSet<string>(StringComparer.Ordinal);
        // Owner of each open message / tool call, so a continuation tagged with a
        // different subagent is rejected here exactly as verifyEvents rejects it in
        // TypeScript. Without this the two SDKs disagreed about the same stream.
        var messageOwners = new Dictionary<string, string?>(StringComparer.Ordinal);
        var toolCallOwners = new Dictionary<string, string?>(StringComparer.Ordinal);
        // Activities are opened by ACTIVITY_SNAPSHOT and continued by ACTIVITY_DELTA on
        // the same messageId, so they need the same owner tracking. TypeScript checks
        // these; without it .NET accepted a stream TypeScript rejects.
        var activityOwners = new Dictionary<string, string?>(StringComparer.Ordinal);
        var runStarted = false;
        var runFinished = false;
        var runError = false;
        var firstEventReceived = false;

        await foreach (var evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            // Verify event ordering and lifecycle rules
            if (runError)
            {
                throw new System.InvalidOperationException(
                    $"Cannot send event type '{evt.Type}': The run has already errored with 'RUN_ERROR'. No further events can be sent.");
            }

            if (runFinished && evt is not RunErrorEvent && evt is not RunStartedEvent)
            {
                throw new System.InvalidOperationException(
                    $"Cannot send event type '{evt.Type}': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.");
            }

            if (!firstEventReceived)
            {
                firstEventReceived = true;
                if (evt is not RunStartedEvent && evt is not RunErrorEvent)
                {
                    throw new System.InvalidOperationException("First event must be 'RUN_STARTED'.");
                }
            }
            else if (evt is RunStartedEvent)
            {
                if (runStarted && !runFinished)
                {
                    throw new System.InvalidOperationException(
                        "Cannot send 'RUN_STARTED' while a run is still active. The previous run must be finished with 'RUN_FINISHED' before starting a new run.");
                }

                if (runFinished)
                {
                    textMessageBuilder.Reset();
                    toolCallBuilder.Reset();
                    activeSteps.Clear();
                    activeSubagents.Clear();
                    closedSubagents.Clear();
                    messageOwners.Clear();
                    toolCallOwners.Clear();
                    activityOwners.Clear();
                    runFinished = false;
                    runError = false;
                    runStarted = true;
                }
            }

            // Subagent lifecycle and attribution rules. Kept beside the run/step rules
            // above and mirroring verifyEvents in sdks/typescript/packages/client, so the
            // same stream is accepted or rejected identically by both SDKs.
            switch (evt)
            {
                case SubagentStartedEvent started:
                    // Required by the protocol schema, which TypeScript enforces with
                    // zod. System.Text.Json has no such notion and leaves a missing
                    // string as the property initializer (string.Empty), so without
                    // this an id-less event would register an active subagent named ""
                    // and corrupt the validation state below — while the TypeScript
                    // client rejected the very same payload.
                    RequireProvided(started.SubagentId, "subagentId", AGUIEventTypes.SubagentStarted);
                    RequireProvided(started.Name, "name", AGUIEventTypes.SubagentStarted);
                    var startedId = started.SubagentId!;

                    if (activeSubagents.ContainsKey(startedId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_STARTED': subagent '{startedId}' is already active. Finish it with 'SUBAGENT_FINISHED' first.");
                    }

                    if (closedSubagents.Contains(startedId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_STARTED': subagent '{startedId}' has already finished in this run. Subagent IDs are per-invocation and cannot be reused.");
                    }

                    if (started.ParentSubagentId is not null
                        && !activeSubagents.ContainsKey(started.ParentSubagentId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_STARTED': parentSubagentId '{started.ParentSubagentId}' has not been started.");
                    }

                    activeSubagents[startedId] = started.ParentSubagentId;
                    break;

                case SubagentFinishedEvent finished:
                    RequireProvided(finished.SubagentId, "subagentId", AGUIEventTypes.SubagentFinished);
                    var finishedId = finished.SubagentId!;
                    if (!activeSubagents.Remove(finishedId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_FINISHED': no active subagent found with ID '{finishedId}'. A 'SUBAGENT_STARTED' event must be sent first.");
                    }

                    closedSubagents.Add(finishedId);
                    break;

                case SubagentErrorEvent subagentErrored:
                    RequireProvided(subagentErrored.SubagentId, "subagentId", AGUIEventTypes.SubagentError);
                    RequireProvided(subagentErrored.Message, "message", AGUIEventTypes.SubagentError);
                    var erroredId = subagentErrored.SubagentId!;
                    if (!activeSubagents.Remove(erroredId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_ERROR': no active subagent found with ID '{erroredId}'. A 'SUBAGENT_STARTED' event must be sent first.");
                    }

                    closedSubagents.Add(erroredId);
                    break;

                // Only the parent owns state. A consumer applies a snapshot or delta
                // without consulting attribution, so an attributed one would land as if
                // the parent had sent it — silently replacing the parent's state with a
                // subagent's partial view. Rejected rather than dropped so a
                // non-conforming producer fails loudly instead of losing state updates.
                case StateSnapshotEvent { SubagentId: not null } attributedSnapshot:
                    throw new System.InvalidOperationException(
                        $"Cannot send 'STATE_SNAPSHOT' attributed to subagent '{attributedSnapshot.SubagentId}': only the parent agent owns state.");

                case StateDeltaEvent { SubagentId: not null } attributedDelta:
                    throw new System.InvalidOperationException(
                        $"Cannot send 'STATE_DELTA' attributed to subagent '{attributedDelta.SubagentId}': only the parent agent owns state.");

                case RunFinishedEvent when activeSubagents.Count > 0:
                    throw new System.InvalidOperationException(
                        $"Cannot send 'RUN_FINISHED' while subagents are still active: {string.Join(", ", activeSubagents.Keys)}");

                // Attribution consistency for the two ID-keyed entities, mirroring
                // verifyEvents. An opener records its owner; a continuation or close
                // tagged with a different subagent is a contradiction, and for tool
                // calls it is the consequential one — args and results are what travel
                // back to the provider on the next turn.
                case TextMessageStartEvent textStart:
                    messageOwners[textStart.MessageId] = textStart.SubagentId;
                    break;

                case TextMessageContentEvent textContent:
                    RejectOwnerMismatch(
                        textContent.Type, textContent.SubagentId, messageOwners, textContent.MessageId, "message");
                    break;

                case TextMessageEndEvent textEnd:
                    RejectOwnerMismatch(
                        textEnd.Type, textEnd.SubagentId, messageOwners, textEnd.MessageId, "message");
                    messageOwners.Remove(textEnd.MessageId);
                    break;

                case ToolCallStartEvent toolStart:
                    toolCallOwners[toolStart.ToolCallId] = toolStart.SubagentId;
                    break;

                case ActivitySnapshotEvent activitySnapshot:
                    activityOwners[activitySnapshot.MessageId] = activitySnapshot.SubagentId;
                    break;

                case ActivityDeltaEvent activityDelta:
                    RejectOwnerMismatch(
                        activityDelta.Type, activityDelta.SubagentId, activityOwners, activityDelta.MessageId, "activity");
                    break;

                case ToolCallArgsEvent toolArgs:
                    RejectOwnerMismatch(
                        toolArgs.Type, toolArgs.SubagentId, toolCallOwners, toolArgs.ToolCallId, "tool call");
                    break;

                case ToolCallEndEvent toolEnd:
                    RejectOwnerMismatch(
                        toolEnd.Type, toolEnd.SubagentId, toolCallOwners, toolEnd.ToolCallId, "tool call");
                    toolCallOwners.Remove(toolEnd.ToolCallId);
                    break;

                default:
                    break;
            }

            switch (evt)
            {
                case RunStartedEvent runStartedEvt:
                    runStarted = true;
                    conversationId = runStartedEvt.ThreadId;
                    responseId = runStartedEvt.RunId;
                    textMessageBuilder.SetConversationAndResponseIds(conversationId, responseId);
                    toolCallBuilder.SetIds(conversationId, responseId);

                    yield return new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        RawRepresentation = runStartedEvt,
                    };
                    break;

                case RunFinishedEvent runFinishedEvt:
                    if (activeSteps.Count > 0)
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'RUN_FINISHED' while steps are still active: {string.Join(", ", activeSteps)}");
                    }

                    textMessageBuilder.EnsureCompleted();
                    toolCallBuilder.EnsureCompleted();

                    runFinished = true;

                    if (runFinishedEvt.Outcome is RunFinishedInterruptOutcome interruptOutcome)
                    {
                        // Flush buffered tool calls, converting interrupted ones to ToolApprovalRequestContent
                        foreach (var toolUpdate in toolCallBuilder.FlushWithInterrupts(interruptOutcome))
                        {
                            yield return toolUpdate;
                        }

                        // Emit non-tool-call interrupts as InterruptRequestContent
                        var nonToolContents = new List<AIContent>();
                        foreach (var interrupt in interruptOutcome.Interrupts)
                        {
                            if (string.Equals(interrupt.Reason, InterruptReasons.ToolCall, System.StringComparison.OrdinalIgnoreCase)
                                && interrupt.ToolCallId is not null)
                            {
                                // Already handled by FlushWithInterrupts above
                                continue;
                            }

                            var inputRequest = new InterruptRequestContent(interrupt.Id)
                            {
                                Reason = interrupt.Reason,
                                Message = interrupt.Message,
                                ToolCallId = interrupt.ToolCallId,
                                ResponseSchema = interrupt.ResponseSchema,
                                ExpiresAt = interrupt.ExpiresAt,
                                Metadata = interrupt.Metadata,
                            };

                            nonToolContents.Add(inputRequest);
                        }

                        if (nonToolContents.Count > 0)
                        {
                            yield return new ChatResponseUpdate
                            {
                                Role = ChatRole.Assistant,
                                ConversationId = conversationId,
                                ResponseId = responseId,
                                Contents = nonToolContents,
                                RawRepresentation = runFinishedEvt
                            };
                        }
                    }
                    else
                    {
                        // Flush any buffered tool calls as regular FunctionCallContent
                        foreach (var toolUpdate in toolCallBuilder.FlushAsToolCalls())
                        {
                            yield return toolUpdate;
                        }

                        yield return new ChatResponseUpdate
                        {
                            Role = ChatRole.Assistant,
                            ConversationId = conversationId,
                            ResponseId = responseId,
                            FinishReason = ChatFinishReason.Stop,
                            RawRepresentation = runFinishedEvt
                        };
                    }

                    break;

                case RunErrorEvent errorEvent:
                    runError = true;
                    yield return new ChatResponseUpdate(ChatRole.Assistant,
                        [new ErrorContent(errorEvent.Message) { ErrorCode = errorEvent.Code }])
                    {
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        RawRepresentation = errorEvent
                    };
                    break;

                case TextMessageStartEvent textStart:
                    textMessageBuilder.AddTextStart(textStart);
                    break;

                case TextMessageContentEvent textContent:
                {
                    var update = textMessageBuilder.EmitTextUpdate(textContent);
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(update);
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }

                case TextMessageEndEvent textEnd:
                    textMessageBuilder.EndCurrentMessage(textEnd);
                    break;

                case StepStartedEvent stepStarted:
                    if (!activeSteps.Add(stepStarted.StepName))
                    {
                        throw new System.InvalidOperationException(
                            $"Step \"{stepStarted.StepName}\" is already active for 'STEP_STARTED'.");
                    }

                    {
                        var update = new ChatResponseUpdate
                        {
                            Role = ChatRole.Assistant,
                            ConversationId = conversationId,
                            ResponseId = responseId,
                            RawRepresentation = stepStarted
                        };
                        if (toolCallBuilder.IsBuffering)
                        {
                            toolCallBuilder.BufferUpdate(update);
                        }
                        else
                        {
                            yield return update;
                        }
                    }
                    break;

                case StepFinishedEvent stepFinished:
                    if (!activeSteps.Remove(stepFinished.StepName))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'STEP_FINISHED' for step \"{stepFinished.StepName}\" that was not started.");
                    }

                    {
                        var update = new ChatResponseUpdate
                        {
                            Role = ChatRole.Assistant,
                            ConversationId = conversationId,
                            ResponseId = responseId,
                            RawRepresentation = stepFinished
                        };
                        if (toolCallBuilder.IsBuffering)
                        {
                            toolCallBuilder.BufferUpdate(update);
                        }
                        else
                        {
                            yield return update;
                        }
                    }
                    break;

                case ToolCallStartEvent toolStart:
                    toolCallBuilder.StartToolCall(toolStart);
                    break;

                case ToolCallArgsEvent toolArgs:
                    toolCallBuilder.AppendArgs(toolArgs);
                    break;

                case ToolCallEndEvent toolEnd:
                    toolCallBuilder.EndToolCall(toolEnd, jsonSerializerOptions);
                    break;

                case ToolCallResultEvent toolResult:
                {
                    var resultUpdate = new ChatResponseUpdate(ChatRole.Tool,
                        [new FunctionResultContent(toolResult.ToolCallId, toolResult.Content)])
                    {
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        RawRepresentation = toolResult
                    };

                    if (toolCallBuilder.IsBuffering)
                    {
                        // Add the result to the buffer and resolve the pending tool call.
                        // If all pending tool calls now have results, flush the entire buffer.
                        foreach (var flushed in toolCallBuilder.AddResult(toolResult.ToolCallId, resultUpdate))
                        {
                            yield return flushed;
                        }
                    }
                    else
                    {
                        yield return resultUpdate;
                    }
                    break;
                }

                case ReasoningMessageContentEvent reasoningContent:
                {
                    var update = new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        Contents = [new TextReasoningContent(reasoningContent.Delta) { RawRepresentation = reasoningContent }],
                        RawRepresentation = reasoningContent
                    };
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(update);
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }

                case ReasoningEncryptedValueEvent encryptedValue:
                {
                    var update = new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        Contents = [new TextReasoningContent(null) { ProtectedData = encryptedValue.EncryptedValue, RawRepresentation = encryptedValue }],
                        RawRepresentation = encryptedValue
                    };
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(update);
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }

                // Pass-through events: state, reasoning lifecycle, activity, custom, raw,
                // and the subagent lifecycle. The subagent events reach the caller as
                // RawRepresentation because Microsoft.Extensions.AI has no concept of
                // delegated work; a consumer that cares reads them off the update, while
                // the validation above has already rejected an inconsistent lifecycle.
                case SubagentStartedEvent:
                case SubagentFinishedEvent:
                case SubagentErrorEvent:
                case StateSnapshotEvent:
                case StateDeltaEvent:
                case ReasoningStartEvent:
                case ReasoningMessageStartEvent:
                case ReasoningMessageEndEvent:
                case ReasoningEndEvent:
                case ReasoningMessageChunkEvent:
                case ActivitySnapshotEvent:
                case ActivityDeltaEvent:
                case CustomEvent:
                case RawEvent:
                default:
                {
                    var update = new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        RawRepresentation = evt
                    };
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(update);
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }
            }
        }
    }

    /// <summary>
    /// Throws when a protocol-required string was ABSENT from the payload.
    /// </summary>
    /// <remarks>
    /// The TypeScript schemas mark these mandatory with <c>z.string()</c>, which
    /// requires the key to be present but accepts an empty value — so this checks for
    /// null, not for empty. The properties are declared nullable precisely to make that
    /// distinction possible: were they non-nullable with a <c>string.Empty</c>
    /// initializer, a missing property and an explicit <c>""</c> would be
    /// indistinguishable, and rejecting both would make .NET stricter than TypeScript
    /// and Python, which is the divergence this is here to prevent.
    /// </remarks>
    private static void RequireProvided(string? value, string propertyName, string eventType)
    {
        if (value is null)
        {
            throw new System.InvalidOperationException(
                $"Cannot send '{eventType}': '{propertyName}' is required.");
        }
    }

    /// <summary>
    /// Throws when a continuation or close event names a different subagent than the
    /// one that opened the entity. An absent tag is not a disagreement: attribution is
    /// optional per event, so producers that tag only openers remain valid.
    /// </summary>
    private static void RejectOwnerMismatch(
        string eventType,
        string? subagentId,
        Dictionary<string, string?> owners,
        string entityId,
        string entityKind)
    {
        if (subagentId is null)
        {
            return;
        }

        // A recorded owner of null means the entity belongs to the PARENT, which is just
        // as much an owner as a subagent — so a tagged continuation on it is still a
        // disagreement. Only the ABSENCE of an entry means "unknown opener".
        if (owners.TryGetValue(entityId, out var owner) && owner != subagentId)
        {
            throw new System.InvalidOperationException(
                $"Cannot send '{eventType}': subagentId '{subagentId}' does not match the {entityKind} '{entityId}' opener's subagent '{owner}'.");
        }
    }
}
