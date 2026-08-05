using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Client;

internal static class EventStreamConverter
{
    internal static async IAsyncEnumerable<ChatResponseUpdate> AsChatResponseUpdates(
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
                    runFinished = false;
                    runError = false;
                    runStarted = true;
                }
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

                // Pass-through events: state, reasoning lifecycle, activity, custom, raw
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
}
