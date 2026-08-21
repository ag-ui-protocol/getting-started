using System;
using System.Collections.Generic;
using System.Text.Json;
using AGUI.Abstractions;
using Google.Protobuf.Collections;
using Proto = AGUI.ProtocolBuffers;

namespace AGUI.Protobuf;

// Maps AG-UI .NET events to and from the generated protobuf Event oneof. The per-event
// reshaping rules (RunFinished outcome/interrupts flattening, StateDelta op<->enum, etc.)
// mirror sdks/typescript/packages/proto/src/proto.ts verbatim so the wire format stays
// byte-compatible with @ag-ui/proto.
internal static class ProtoEventMapper
{
    private const string OutcomeSuccess = "success";
    private const string OutcomeInterrupt = "interrupt";

    public static Proto.Event ToProto(BaseEvent evt)
    {
        switch (evt)
        {
            case RunStartedEvent e:
                return new Proto.Event
                {
                    RunStarted = new Proto.RunStartedEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.RunStarted),
                        ThreadId = e.ThreadId,
                        RunId = e.RunId,
                    },
                };
            case RunFinishedEvent e:
            {
                var runFinished = new Proto.RunFinishedEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.RunFinished),
                    ThreadId = e.ThreadId,
                    RunId = e.RunId,
                };

                if (e.Result is not null)
                {
                    runFinished.Result = ProtoValueConverter.ToValue(e.Result.Value);
                }

                if (e.Outcome is RunFinishedInterruptOutcome interruptOutcome)
                {
                    runFinished.Outcome = OutcomeInterrupt;
                    foreach (var interrupt in interruptOutcome.Interrupts)
                    {
                        runFinished.Interrupts.Add(ProtoMessageMapper.ToProtoInterrupt(interrupt));
                    }
                }
                else if (e.Outcome is RunFinishedSuccessOutcome)
                {
                    runFinished.Outcome = OutcomeSuccess;
                }
                else
                {
                    runFinished.Outcome = string.Empty;
                }

                AddUsage(runFinished.Usage, e.Usage);

                return new Proto.Event { RunFinished = runFinished };
            }
            case RunErrorEvent e:
            {
                var runError = new Proto.RunErrorEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.RunError),
                    Message = e.Message,
                };

                if (e.Code is not null)
                {
                    runError.Code = e.Code;
                }

                AddUsage(runError.Usage, e.Usage);

                return new Proto.Event { RunError = runError };
            }
            case StepStartedEvent e:
                return new Proto.Event
                {
                    StepStarted = new Proto.StepStartedEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.StepStarted),
                        StepName = e.StepName,
                    },
                };
            case StepFinishedEvent e:
                return new Proto.Event
                {
                    StepFinished = new Proto.StepFinishedEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.StepFinished),
                        StepName = e.StepName,
                    },
                };
            case TextMessageStartEvent e:
            {
                var start = new Proto.TextMessageStartEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.TextMessageStart),
                    MessageId = e.MessageId,
                    Role = e.Role,
                };

                if (e.Name is not null)
                {
                    start.Name = e.Name;
                }

                return new Proto.Event { TextMessageStart = start };
            }
            case TextMessageContentEvent e:
                return new Proto.Event
                {
                    TextMessageContent = new Proto.TextMessageContentEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.TextMessageContent),
                        MessageId = e.MessageId,
                        Delta = e.Delta,
                    },
                };
            case TextMessageEndEvent e:
                return new Proto.Event
                {
                    TextMessageEnd = new Proto.TextMessageEndEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.TextMessageEnd),
                        MessageId = e.MessageId,
                    },
                };
            case ToolCallStartEvent e:
            {
                var start = new Proto.ToolCallStartEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.ToolCallStart),
                    ToolCallId = e.ToolCallId,
                    ToolCallName = e.ToolCallName,
                };

                if (e.ParentMessageId is not null)
                {
                    start.ParentMessageId = e.ParentMessageId;
                }

                return new Proto.Event { ToolCallStart = start };
            }
            case ToolCallArgsEvent e:
                return new Proto.Event
                {
                    ToolCallArgs = new Proto.ToolCallArgsEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.ToolCallArgs),
                        ToolCallId = e.ToolCallId,
                        Delta = e.Delta,
                    },
                };
            case ToolCallEndEvent e:
                return new Proto.Event
                {
                    ToolCallEnd = new Proto.ToolCallEndEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.ToolCallEnd),
                        ToolCallId = e.ToolCallId,
                    },
                };
            case StateSnapshotEvent e:
                return new Proto.Event
                {
                    StateSnapshot = new Proto.StateSnapshotEvent
                    {
                        BaseEvent = BuildBaseEvent(e, Proto.EventType.StateSnapshot),
                        Snapshot = ProtoValueConverter.ToValue(e.Snapshot),
                    },
                };
            case StateDeltaEvent e:
            {
                var stateDelta = new Proto.StateDeltaEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.StateDelta),
                };

                if (e.Delta.ValueKind == JsonValueKind.Array)
                {
                    foreach (var operation in e.Delta.EnumerateArray())
                    {
                        stateDelta.Delta.Add(ProtoMessageMapper.ToProtoPatchOperation(operation));
                    }
                }

                return new Proto.Event { StateDelta = stateDelta };
            }
            case MessagesSnapshotEvent e:
            {
                var snapshot = new Proto.MessagesSnapshotEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.MessagesSnapshot),
                };

                foreach (var message in e.Messages)
                {
                    snapshot.Messages.Add(ProtoMessageMapper.ToProto(message));
                }

                return new Proto.Event { MessagesSnapshot = snapshot };
            }
            case RawEvent e:
            {
                var raw = new Proto.RawEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.Raw),
                    Event = ProtoValueConverter.ToValue(e.Event),
                };

                if (e.Source is not null)
                {
                    raw.Source = e.Source;
                }

                return new Proto.Event { Raw = raw };
            }
            case CustomEvent e:
            {
                var custom = new Proto.CustomEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.Custom),
                    Name = e.Name,
                };

                if (e.Value is not null)
                {
                    custom.Value = ProtoValueConverter.ToValue(e.Value.Value);
                }

                return new Proto.Event { Custom = custom };
            }
            default:
                throw new NotSupportedException(
                    $"Event type '{evt.Type}' is not representable in the AG-UI protobuf wire format. " +
                    "Supported events: RUN_STARTED, RUN_FINISHED, RUN_ERROR, STEP_STARTED, STEP_FINISHED, " +
                    "TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, TOOL_CALL_START, TOOL_CALL_ARGS, " +
                    "TOOL_CALL_END, STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT, RAW, CUSTOM.");
        }
    }

    public static BaseEvent FromProto(Proto.Event proto)
    {
        switch (proto.EventCase)
        {
            case Proto.Event.EventOneofCase.RunStarted:
            {
                var e = proto.RunStarted;
                var result = new RunStartedEvent { ThreadId = e.ThreadId, RunId = e.RunId };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.RunFinished:
            {
                var e = proto.RunFinished;
                var result = new RunFinishedEvent
                {
                    ThreadId = e.ThreadId,
                    RunId = e.RunId,
                    Result = ProtoValueConverter.ToJsonElementOrNull(e.Result),
                    Outcome = BuildOutcome(e),
                    Usage = BuildUsage(e.Usage),
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.RunError:
            {
                var e = proto.RunError;
                var result = new RunErrorEvent
                {
                    Message = e.Message,
                    Code = e.HasCode ? e.Code : null,
                    Usage = BuildUsage(e.Usage),
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.StepStarted:
            {
                var e = proto.StepStarted;
                var result = new StepStartedEvent { StepName = e.StepName };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.StepFinished:
            {
                var e = proto.StepFinished;
                var result = new StepFinishedEvent { StepName = e.StepName };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.TextMessageStart:
            {
                var e = proto.TextMessageStart;
                var result = new TextMessageStartEvent
                {
                    MessageId = e.MessageId,
                    Role = e.HasRole ? e.Role : string.Empty,
                    Name = e.HasName ? e.Name : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.TextMessageContent:
            {
                var e = proto.TextMessageContent;
                var result = new TextMessageContentEvent { MessageId = e.MessageId, Delta = e.Delta };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.TextMessageEnd:
            {
                var e = proto.TextMessageEnd;
                var result = new TextMessageEndEvent { MessageId = e.MessageId };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.ToolCallStart:
            {
                var e = proto.ToolCallStart;
                var result = new ToolCallStartEvent
                {
                    ToolCallId = e.ToolCallId,
                    ToolCallName = e.ToolCallName,
                    ParentMessageId = e.HasParentMessageId ? e.ParentMessageId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.ToolCallArgs:
            {
                var e = proto.ToolCallArgs;
                var result = new ToolCallArgsEvent { ToolCallId = e.ToolCallId, Delta = e.Delta };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.ToolCallEnd:
            {
                var e = proto.ToolCallEnd;
                var result = new ToolCallEndEvent { ToolCallId = e.ToolCallId };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.StateSnapshot:
            {
                var e = proto.StateSnapshot;
                var result = new StateSnapshotEvent
                {
                    Snapshot = e.Snapshot is null
                        ? default
                        : ProtoValueConverter.ToJsonElement(e.Snapshot),
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.StateDelta:
            {
                var e = proto.StateDelta;
                var result = new StateDeltaEvent { Delta = BuildPatchArray(e) };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.MessagesSnapshot:
            {
                var e = proto.MessagesSnapshot;
                var result = new MessagesSnapshotEvent();
                foreach (var message in e.Messages)
                {
                    result.Messages.Add(ProtoMessageMapper.FromProto(message));
                }

                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.Raw:
            {
                var e = proto.Raw;
                var result = new RawEvent
                {
                    Event = e.Event is null ? default : ProtoValueConverter.ToJsonElement(e.Event),
                    Source = e.HasSource ? e.Source : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.Custom:
            {
                var e = proto.Custom;
                var result = new CustomEvent
                {
                    Name = e.Name,
                    Value = ProtoValueConverter.ToJsonElementOrNull(e.Value),
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            default:
                throw new NotSupportedException(
                    "The protobuf message does not contain a supported AG-UI event variant.");
        }
    }

    private static Proto.BaseEvent BuildBaseEvent(BaseEvent evt, Proto.EventType type)
    {
        var baseEvent = new Proto.BaseEvent { Type = type };

        if (evt.Timestamp.HasValue)
        {
            baseEvent.Timestamp = evt.Timestamp.Value;
        }

        if (evt.RawEvent is not null)
        {
            baseEvent.RawEvent = ProtoValueConverter.ToValue(evt.RawEvent.Value);
        }

        baseEvent.Metadata = ProtoValueConverter.ToStructOrNull(evt.Metadata);

        return baseEvent;
    }

    private static void ApplyBaseEvent(BaseEvent target, Proto.BaseEvent? baseEvent)
    {
        if (baseEvent is null)
        {
            return;
        }

        if (baseEvent.HasTimestamp)
        {
            target.Timestamp = baseEvent.Timestamp;
        }

        if (baseEvent.RawEvent is not null)
        {
            target.RawEvent = ProtoValueConverter.ToJsonElement(baseEvent.RawEvent);
        }

        target.Metadata = ProtoValueConverter.StructToJsonElementOrNull(baseEvent.Metadata);
    }

    private static RunFinishedOutcome? BuildOutcome(Proto.RunFinishedEvent proto)
    {
        if (proto.Outcome == OutcomeInterrupt)
        {
            var outcome = new RunFinishedInterruptOutcome();
            foreach (var interrupt in proto.Interrupts)
            {
                outcome.Interrupts.Add(ProtoMessageMapper.FromProtoInterrupt(interrupt));
            }

            return outcome;
        }

        if (proto.Outcome == OutcomeSuccess)
        {
            return new RunFinishedSuccessOutcome();
        }

        return null;
    }

    // Token usage maps 1:1 onto the `repeated Usage` field. An absent list and an
    // empty list both encode to zero entries, so legacy events (no usage) stay
    // byte-for-byte identical on the wire; decoding mirrors that by returning null
    // rather than an empty list. Counts are `optional` in the schema, so a count the
    // producer never reported stays null instead of collapsing to 0.
    private static void AddUsage(RepeatedField<Proto.Usage> target, IList<TokenUsage>? usage)
    {
        if (usage is null)
        {
            return;
        }

        foreach (var entry in usage)
        {
            var proto = new Proto.Usage();
            if (entry.Provider is not null)
            {
                proto.Provider = entry.Provider;
            }

            if (entry.Model is not null)
            {
                proto.Model = entry.Model;
            }

            if (entry.InputTokens is { } inputTokens)
            {
                proto.InputTokens = inputTokens;
            }

            if (entry.OutputTokens is { } outputTokens)
            {
                proto.OutputTokens = outputTokens;
            }

            if (entry.TotalTokens is { } totalTokens)
            {
                proto.TotalTokens = totalTokens;
            }

            if (entry.ReasoningTokens is { } reasoningTokens)
            {
                proto.ReasoningTokens = reasoningTokens;
            }

            if (entry.CachedInputTokens is { } cachedInputTokens)
            {
                proto.CachedInputTokens = cachedInputTokens;
            }

            target.Add(proto);
        }
    }

    private static IList<TokenUsage>? BuildUsage(RepeatedField<Proto.Usage> usage)
    {
        if (usage.Count == 0)
        {
            return null;
        }

        var result = new List<TokenUsage>(usage.Count);
        foreach (var entry in usage)
        {
            result.Add(new TokenUsage
            {
                Provider = entry.HasProvider ? entry.Provider : null,
                Model = entry.HasModel ? entry.Model : null,
                InputTokens = entry.HasInputTokens ? entry.InputTokens : null,
                OutputTokens = entry.HasOutputTokens ? entry.OutputTokens : null,
                TotalTokens = entry.HasTotalTokens ? entry.TotalTokens : null,
                ReasoningTokens = entry.HasReasoningTokens ? entry.ReasoningTokens : null,
                CachedInputTokens = entry.HasCachedInputTokens ? entry.CachedInputTokens : null,
            });
        }

        return result;
    }

    private static JsonElement BuildPatchArray(Proto.StateDeltaEvent proto)
    {
        return JsonElementFactory.Create(writer =>
        {
            writer.WriteStartArray();
            foreach (var operation in proto.Delta)
            {
                ProtoMessageMapper.WriteProtoPatchOperation(writer, operation);
            }

            writer.WriteEndArray();
        });
    }
}
