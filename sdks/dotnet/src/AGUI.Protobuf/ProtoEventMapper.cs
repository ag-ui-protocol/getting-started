using System;
using System.Text.Json;
using AGUI.Abstractions;
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

                return new Proto.Event { RunError = runError };
            }
            case StepStartedEvent e:
            {
                var stepStarted = new Proto.StepStartedEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.StepStarted),
                    StepName = e.StepName,
                };

                if (e.SubagentId is not null)
                {
                    stepStarted.SubagentId = e.SubagentId;
                }

                return new Proto.Event { StepStarted = stepStarted };
            }
            case StepFinishedEvent e:
            {
                var stepFinished = new Proto.StepFinishedEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.StepFinished),
                    StepName = e.StepName,
                };

                if (e.SubagentId is not null)
                {
                    stepFinished.SubagentId = e.SubagentId;
                }

                return new Proto.Event { StepFinished = stepFinished };
            }
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

                if (e.SubagentId is not null)
                {
                    start.SubagentId = e.SubagentId;
                }

                return new Proto.Event { TextMessageStart = start };
            }
            case TextMessageContentEvent e:
            {
                var content = new Proto.TextMessageContentEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.TextMessageContent),
                    MessageId = e.MessageId,
                    Delta = e.Delta,
                };

                if (e.SubagentId is not null)
                {
                    content.SubagentId = e.SubagentId;
                }

                return new Proto.Event { TextMessageContent = content };
            }
            case TextMessageEndEvent e:
            {
                var end = new Proto.TextMessageEndEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.TextMessageEnd),
                    MessageId = e.MessageId,
                };

                if (e.SubagentId is not null)
                {
                    end.SubagentId = e.SubagentId;
                }

                return new Proto.Event { TextMessageEnd = end };
            }
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

                if (e.SubagentId is not null)
                {
                    start.SubagentId = e.SubagentId;
                }

                return new Proto.Event { ToolCallStart = start };
            }
            case ToolCallArgsEvent e:
            {
                var args = new Proto.ToolCallArgsEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.ToolCallArgs),
                    ToolCallId = e.ToolCallId,
                    Delta = e.Delta,
                };

                if (e.SubagentId is not null)
                {
                    args.SubagentId = e.SubagentId;
                }

                return new Proto.Event { ToolCallArgs = args };
            }
            case ToolCallEndEvent e:
            {
                var toolCallEnd = new Proto.ToolCallEndEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.ToolCallEnd),
                    ToolCallId = e.ToolCallId,
                };

                if (e.SubagentId is not null)
                {
                    toolCallEnd.SubagentId = e.SubagentId;
                }

                return new Proto.Event { ToolCallEnd = toolCallEnd };
            }
            case StateSnapshotEvent e:
            {
                var stateSnapshot = new Proto.StateSnapshotEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.StateSnapshot),
                    Snapshot = ProtoValueConverter.ToValue(e.Snapshot),
                };

                // Carried for schema parity only — a conforming producer never attributes
                // state to a subagent. Mapped rather than dropped so a non-conforming
                // stream stays diagnosable end to end instead of losing the evidence here.
                if (e.SubagentId is not null)
                {
                    stateSnapshot.SubagentId = e.SubagentId;
                }

                return new Proto.Event { StateSnapshot = stateSnapshot };
            }
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

                if (e.SubagentId is not null)
                {
                    stateDelta.SubagentId = e.SubagentId;
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

                if (e.SubagentId is not null)
                {
                    raw.SubagentId = e.SubagentId;
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

                if (e.SubagentId is not null)
                {
                    custom.SubagentId = e.SubagentId;
                }

                return new Proto.Event { Custom = custom };
            }
            case SubagentStartedEvent e:
            {
                var subagentStarted = new Proto.SubagentStartedEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.SubagentStarted),
                    SubagentId = e.SubagentId,
                    Name = e.Name,
                };

                if (e.Description is not null)
                {
                    subagentStarted.Description = e.Description;
                }

                if (e.ParentSubagentId is not null)
                {
                    subagentStarted.ParentSubagentId = e.ParentSubagentId;
                }

                if (e.ParentToolCallId is not null)
                {
                    subagentStarted.ParentToolCallId = e.ParentToolCallId;
                }

                if (e.ParentMessageId is not null)
                {
                    subagentStarted.ParentMessageId = e.ParentMessageId;
                }

                return new Proto.Event { SubagentStarted = subagentStarted };
            }
            case SubagentFinishedEvent e:
            {
                var subagentFinished = new Proto.SubagentFinishedEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.SubagentFinished),
                    SubagentId = e.SubagentId,
                };

                if (e.Result is not null)
                {
                    subagentFinished.Result = ProtoValueConverter.ToValue(e.Result.Value);
                }

                return new Proto.Event { SubagentFinished = subagentFinished };
            }
            case SubagentErrorEvent e:
            {
                var subagentError = new Proto.SubagentErrorEvent
                {
                    BaseEvent = BuildBaseEvent(e, Proto.EventType.SubagentError),
                    SubagentId = e.SubagentId,
                    Message = e.Message,
                };

                if (e.Code is not null)
                {
                    subagentError.Code = e.Code;
                }

                return new Proto.Event { SubagentError = subagentError };
            }
            default:
                throw new NotSupportedException(
                    $"Event type '{evt.Type}' is not representable in the AG-UI protobuf wire format. " +
                    "Supported events: RUN_STARTED, RUN_FINISHED, RUN_ERROR, STEP_STARTED, STEP_FINISHED, " +
                    "TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, TOOL_CALL_START, TOOL_CALL_ARGS, " +
                    "TOOL_CALL_END, STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT, RAW, CUSTOM, " +
                    "SUBAGENT_STARTED, SUBAGENT_FINISHED, SUBAGENT_ERROR.");
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
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.StepStarted:
            {
                var e = proto.StepStarted;
                var result = new StepStartedEvent
                {
                    StepName = e.StepName,
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.StepFinished:
            {
                var e = proto.StepFinished;
                var result = new StepFinishedEvent
                {
                    StepName = e.StepName,
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
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
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.TextMessageContent:
            {
                var e = proto.TextMessageContent;
                var result = new TextMessageContentEvent
                {
                    MessageId = e.MessageId,
                    Delta = e.Delta,
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.TextMessageEnd:
            {
                var e = proto.TextMessageEnd;
                var result = new TextMessageEndEvent
                {
                    MessageId = e.MessageId,
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
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
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.ToolCallArgs:
            {
                var e = proto.ToolCallArgs;
                var result = new ToolCallArgsEvent
                {
                    ToolCallId = e.ToolCallId,
                    Delta = e.Delta,
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.ToolCallEnd:
            {
                var e = proto.ToolCallEnd;
                var result = new ToolCallEndEvent
                {
                    ToolCallId = e.ToolCallId,
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
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
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.StateDelta:
            {
                var e = proto.StateDelta;
                var result = new StateDeltaEvent
                {
                    Delta = BuildPatchArray(e),
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
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
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
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
                    SubagentId = e.HasSubagentId ? e.SubagentId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.SubagentStarted:
            {
                var e = proto.SubagentStarted;
                var result = new SubagentStartedEvent
                {
                    SubagentId = e.SubagentId,
                    Name = e.Name,
                    Description = e.HasDescription ? e.Description : null,
                    ParentSubagentId = e.HasParentSubagentId ? e.ParentSubagentId : null,
                    ParentToolCallId = e.HasParentToolCallId ? e.ParentToolCallId : null,
                    ParentMessageId = e.HasParentMessageId ? e.ParentMessageId : null,
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.SubagentFinished:
            {
                var e = proto.SubagentFinished;
                var result = new SubagentFinishedEvent
                {
                    SubagentId = e.SubagentId,
                    Result = ProtoValueConverter.ToJsonElementOrNull(e.Result),
                };
                ApplyBaseEvent(result, e.BaseEvent);
                return result;
            }
            case Proto.Event.EventOneofCase.SubagentError:
            {
                var e = proto.SubagentError;
                var result = new SubagentErrorEvent
                {
                    SubagentId = e.SubagentId,
                    Message = e.Message,
                    Code = e.HasCode ? e.Code : null,
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
