using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AGUI.Abstractions;
using Xunit;
using Proto = AGUI.ProtocolBuffers;

namespace AGUI.Protobuf.UnitTests;

/// <summary>
/// The decode guards, mirrored from the generated TypeScript translation so
/// both runtimes answer malformed wire input identically: with an error,
/// never with silently different events.
/// </summary>
public sealed class WireGuardTest
{
    private static byte[] Wrap(Proto.Event envelope)
        => Google.Protobuf.MessageExtensions.ToByteArray(envelope);

    [Fact]
    public void EmptyEnvelope_Throws()
    {
        Assert.ThrowsAny<Exception>(() => AGUIProtobuf.Decode(Array.Empty<byte>()));
    }

    [Fact]
    public void RepeatedEnvelopeTag_Throws()
    {
        var first = AGUIProtobuf.Encode(new StepFinishedEvent { StepName = "plan" });
        var second = AGUIProtobuf.Encode(new StepFinishedEvent());
        var concatenated = first.Concat(second).ToArray();
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(concatenated));
    }

    [Fact]
    public void TwoDifferentEvents_Throw()
    {
        var first = AGUIProtobuf.Encode(new StepFinishedEvent { StepName = "plan" });
        var second = AGUIProtobuf.Encode(new TextMessageStartEvent { MessageId = "m1" });
        var concatenated = first.Concat(second).ToArray();
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(concatenated));
    }

    [Fact]
    public void UnknownEnvelopeFields_AreIgnoredPerProtobufRules()
    {
        var valid = AGUIProtobuf.Encode(new StepFinishedEvent { StepName = "plan" });
        // Field 90, length-delimited, empty — twice. Unknown, so ignored.
        var unknown = new byte[] { 0xd2, 0x05, 0x00, 0xd2, 0x05, 0x00 };
        var extended = valid.Concat(unknown).ToArray();
        var decoded = Assert.IsType<StepFinishedEvent>(AGUIProtobuf.Decode(extended));
        Assert.Equal("plan", decoded.StepName);
    }

    [Fact]
    public void UnknownGroupFields_AreIgnored_KnownTagInsideDoesNotCount()
    {
        var valid = AGUIProtobuf.Encode(new StepFinishedEvent { StepName = "plan" });
        var group = new byte[]
        {
            0xd3, 0x05, // SGROUP 90
            0x80, 0x01, 0x00, // field 16, varint 0 — inside the group
            0xdb, 0x05, 0xdc, 0x05, // nested SGROUP/EGROUP 91
            0xd4, 0x05, // EGROUP 90
        };
        var extended = valid.Concat(group).ToArray();
        var decoded = Assert.IsType<StepFinishedEvent>(AGUIProtobuf.Decode(extended));
        Assert.Equal("plan", decoded.StepName);
    }

    [Fact]
    public void OverlongVarintDuplicate_Throws()
    {
        var valid = AGUIProtobuf.Encode(new StepFinishedEvent { StepName = "plan" });
        // Field 16 again with the same payload, its tag varint encoded
        // overlong: the reader masks the fifth byte to four bits and still
        // sees field 16.
        var payload = valid.Skip(2).ToArray();
        var overlong = new byte[] { 0x82, 0x81, 0x80, 0x80, 0x10 }.Concat(payload).ToArray();
        var extended = valid.Concat(overlong).ToArray();
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(extended));
    }

    [Fact]
    public void FieldZero_Throws()
    {
        var valid = AGUIProtobuf.Encode(new StepFinishedEvent { StepName = "plan" });
        var extended = valid.Concat(new byte[] { 0x00, 0x00 }).ToArray();
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(extended));
    }

    [Fact]
    public void UnknownOutcome_Throws()
    {
        var bytes = Wrap(new Proto.Event
        {
            RunFinished = new Proto.RunFinishedEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.RunFinished },
                ThreadId = "t1",
                RunId = "r1",
                Outcome = "cancelled",
            },
        });
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
    }

    [Fact]
    public void SuccessOutcomeCarryingInterrupts_Throws()
    {
        var proto = new Proto.RunFinishedEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.RunFinished },
            ThreadId = "t1",
            RunId = "r1",
            Outcome = "success",
        };
        proto.Interrupts.Add(new Proto.Interrupt { Id = "i1", Reason = "r" });
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(Wrap(new Proto.Event { RunFinished = proto })));
    }

    [Fact]
    public void AbsentOutcomeCarryingInterrupts_Throws()
    {
        var proto = new Proto.RunFinishedEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.RunFinished },
            ThreadId = "t1",
            RunId = "r1",
            Outcome = string.Empty,
        };
        proto.Interrupts.Add(new Proto.Interrupt { Id = "i1", Reason = "r" });
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(Wrap(new Proto.Event { RunFinished = proto })));
    }

    [Fact]
    public void UnknownPatchOperation_Throws()
    {
        var stateDelta = new Proto.StateDeltaEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.StateDelta },
        };
        stateDelta.Delta.Add(new Proto.JsonPatchOperation
        {
            Op = (Proto.JsonPatchOperationType)99,
            Path = "/x",
        });
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(Wrap(new Proto.Event { StateDelta = stateDelta })));
    }

    [Fact]
    public void ActivityContentOnNonActivityRole_Throws()
    {
        var snapshot = new Proto.MessagesSnapshotEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.MessagesSnapshot },
        };
        snapshot.Messages.Add(new Proto.Message
        {
            Id = "a1",
            Role = "assistant",
            Content = "hi",
            ActivityContent = new Google.Protobuf.WellKnownTypes.Struct(),
        });
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(Wrap(new Proto.Event { MessagesSnapshot = snapshot })));
    }

    [Fact]
    public void ContentPartsOnPartlessRole_Throw()
    {
        var snapshot = new Proto.MessagesSnapshotEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.MessagesSnapshot },
        };
        var message = new Proto.Message { Id = "a1", Role = "assistant", Content = "hi" };
        message.ContentParts.Add(new Proto.InputContent
        {
            Text = new Proto.TextInputPart { Text = "erased" },
        });
        snapshot.Messages.Add(message);
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(Wrap(new Proto.Event { MessagesSnapshot = snapshot })));
    }

    [Fact]
    public void StringContentAlongsideParts_Throws()
    {
        var snapshot = new Proto.MessagesSnapshotEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.MessagesSnapshot },
        };
        var message = new Proto.Message { Id = "u1", Role = "user", Content = "hi" };
        message.ContentParts.Add(new Proto.InputContent
        {
            Text = new Proto.TextInputPart { Text = "also" },
        });
        snapshot.Messages.Add(message);
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(Wrap(new Proto.Event { MessagesSnapshot = snapshot })));
    }

    [Fact]
    public void BaseEventTypeDisagreeingWithEnvelopeEntry_Throws()
    {
        var bytes = Wrap(new Proto.Event
        {
            StepStarted = new Proto.StepStartedEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.StepFinished },
                StepName = "plan",
            },
        });
        var exception = Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
        Assert.Contains("envelope carries", exception.Message);
    }

    [Fact]
    public void MissingBaseEvent_Throws()
    {
        var bytes = Wrap(new Proto.Event
        {
            StepFinished = new Proto.StepFinishedEvent { StepName = "plan" },
        });
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
    }

    [Fact]
    public void InterruptOutcomeWithNoInterrupts_Throws()
    {
        var bytes = Wrap(new Proto.Event
        {
            RunFinished = new Proto.RunFinishedEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.RunFinished },
                ThreadId = "t1",
                RunId = "r1",
                Outcome = "interrupt",
            },
        });
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
    }

    [Fact]
    public void OutOfEnumSubtype_Throws()
    {
        var bytes = Wrap(new Proto.Event
        {
            ReasoningEncryptedValue = new Proto.ReasoningEncryptedValueEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.ReasoningEncryptedValue },
                Subtype = "bogus",
                EntityId = "m1",
                EncryptedValue = "v",
            },
        });
        var exception = Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
        Assert.Contains("bogus", exception.Message);
    }

    [Fact]
    public void MissingRequiredJsonField_Throws()
    {
        var bytes = Wrap(new Proto.Event
        {
            StateSnapshot = new Proto.StateSnapshotEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.StateSnapshot },
            },
        });
        var exception = Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
        Assert.Contains("snapshot", exception.Message);
    }

    /// <summary>Length-delimited protobuf framing: tag, length, payload.</summary>
    private static byte[] Framed(int fieldNumber, byte[] payload)
    {
        var frame = new List<byte>();
        uint tag = ((uint)fieldNumber << 3) | 2;
        while (tag >= 0x80)
        {
            frame.Add((byte)(tag | 0x80));
            tag >>= 7;
        }

        frame.Add((byte)tag);
        uint length = (uint)payload.Length;
        while (length >= 0x80)
        {
            frame.Add((byte)(length | 0x80));
            length >>= 7;
        }

        frame.Add((byte)length);
        frame.AddRange(payload);
        return frame.ToArray();
    }

    /// <summary>
    /// Wraps raw InputContent bytes as: user message -> messages snapshot ->
    /// envelope, using the frozen field numbers (Message.content_parts = 8,
    /// MessagesSnapshotEvent.messages = 2, Event.messages_snapshot = 9).
    /// </summary>
    private static byte[] EnvelopeWithRawContentPart(byte[] partBytes)
    {
        var messageBytes = Google.Protobuf.MessageExtensions
            .ToByteArray(new Proto.Message { Id = "u1", Role = "user" })
            .Concat(Framed(8, partBytes))
            .ToArray();
        var snapshotBytes = Google.Protobuf.MessageExtensions
            .ToByteArray(new Proto.MessagesSnapshotEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.MessagesSnapshot },
            })
            .Concat(Framed(2, messageBytes))
            .ToArray();
        return Framed(9, snapshotBytes);
    }

    [Fact]
    public void ContentPartCarryingTwoArms_Throws()
    {
        // The C# protobuf parser would keep only the last arm; the scan
        // rejects instead, as the TypeScript translation does.
        var twoArms = Google.Protobuf.MessageExtensions
            .ToByteArray(new Proto.InputContent
            {
                Text = new Proto.TextInputPart { Text = "a" },
            })
            .Concat(Google.Protobuf.MessageExtensions.ToByteArray(new Proto.InputContent
            {
                Image = new Proto.ImageInputPart
                {
                    Source = new Proto.InputContentSource
                    {
                        Url = new Proto.InputContentUrlSource { Value = "u" },
                    },
                },
            }))
            .ToArray();
        var exception = Assert.Throws<InvalidDataException>(
            () => AGUIProtobuf.Decode(EnvelopeWithRawContentPart(twoArms)));
        Assert.Contains("more than one arm", exception.Message);
    }

    [Fact]
    public void ContentPartRepeatingTheSameArm_Throws()
    {
        // A repeated occurrence of the SAME singular field merges here but
        // replaces in ts-proto — the same bytes would materialise different
        // text across runtimes, so both reject.
        var repeated = Google.Protobuf.MessageExtensions
            .ToByteArray(new Proto.InputContent
            {
                Text = new Proto.TextInputPart { Text = "a" },
            })
            .Concat(Google.Protobuf.MessageExtensions.ToByteArray(new Proto.InputContent
            {
                Text = new Proto.TextInputPart { Text = "b" },
            }))
            .ToArray();
        Assert.Throws<InvalidDataException>(
            () => AGUIProtobuf.Decode(EnvelopeWithRawContentPart(repeated)));
    }

    // The StepFinishedEvent envelope entry (field 16 in the freeze).
    private const int StepFinishedTag = 16;

    private static byte[] StepFinishedBytes() =>
        Google.Protobuf.MessageExtensions.ToByteArray(new Proto.StepFinishedEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.StepFinished },
            StepName = "plan",
        });

    [Fact]
    public void HandFramedValidEvent_Decodes()
    {
        // The positive control for the doctored-bytes tests: the same framing
        // helper produces an envelope decode accepts, so the rejections below
        // come from the duplicate, not from broken framing.
        var decoded = Assert.IsType<StepFinishedEvent>(
            AGUIProtobuf.Decode(Framed(StepFinishedTag, StepFinishedBytes())));
        Assert.Equal("plan", decoded.StepName);
    }

    [Fact]
    public void DuplicatedBaseEvent_Throws()
    {
        // Canonical parsers merge the two base events (this runtime included)
        // while ts-proto keeps only the last; reject rather than diverge.
        var extraBaseEvent = Framed(1, Google.Protobuf.MessageExtensions.ToByteArray(
            new Proto.BaseEvent { Type = Proto.EventType.StepFinished, Timestamp = 9 }));
        var doctored = Framed(StepFinishedTag, StepFinishedBytes().Concat(extraBaseEvent).ToArray());
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(doctored));
    }

    [Fact]
    public void UnknownResumeStatus_Throws()
    {
        var input = new Proto.RunAgentInput { ThreadId = "t1", RunId = "r1" };
        input.Resume.Add(new Proto.ResumeEntry { InterruptId = "i1", Status = "bogus" });
        var bytes = Wrap(new Proto.Event
        {
            RunStarted = new Proto.RunStartedEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.RunStarted },
                ThreadId = "t1",
                RunId = "r1",
                Input = input,
            },
        });
        var exception = Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
        Assert.Contains("bogus", exception.Message);
    }

    [Fact]
    public void ToolCallMissingFunction_Throws()
    {
        var snapshot = new Proto.MessagesSnapshotEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.MessagesSnapshot },
        };
        var message = new Proto.Message { Id = "a1", Role = "assistant" };
        message.ToolCalls.Add(new Proto.ToolCall { Id = "c1", Type = "function" });
        snapshot.Messages.Add(message);
        var exception = Assert.Throws<InvalidDataException>(
            () => AGUIProtobuf.Decode(Wrap(new Proto.Event { MessagesSnapshot = snapshot })));
        Assert.Contains("function", exception.Message);
    }

    [Fact]
    public void MissingActivitySnapshotContent_Throws()
    {
        var bytes = Wrap(new Proto.Event
        {
            ActivitySnapshot = new Proto.ActivitySnapshotEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.ActivitySnapshot },
                MessageId = "a1",
                ActivityType = "search",
            },
        });
        var exception = Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
        Assert.Contains("content", exception.Message);
    }

    [Fact]
    public void SourceCarryingTwoArms_Throws()
    {
        // InputContentSource.data = 1, .url = 2; ImageInputPart.source = 1;
        // InputContent.image = 2.
        var twoArmSource = Google.Protobuf.MessageExtensions
            .ToByteArray(new Proto.InputContentSource
            {
                Data = new Proto.InputContentDataSource { Value = "aGk=", MimeType = "a/b" },
            })
            .Concat(Google.Protobuf.MessageExtensions.ToByteArray(new Proto.InputContentSource
            {
                Url = new Proto.InputContentUrlSource { Value = "u" },
            }))
            .ToArray();
        var partBytes = Framed(2, Framed(1, twoArmSource));
        var exception = Assert.Throws<InvalidDataException>(
            () => AGUIProtobuf.Decode(EnvelopeWithRawContentPart(partBytes)));
        Assert.Contains("more than one arm", exception.Message);
    }

    [Fact]
    public void EmptyUserPartsArray_IsValidContent()
    {
        var snapshot = new Proto.MessagesSnapshotEvent
        {
            BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.MessagesSnapshot },
        };
        snapshot.Messages.Add(new Proto.Message { Id = "u1", Role = "user" });
        var decoded = Assert.IsType<MessagesSnapshotEvent>(
            AGUIProtobuf.Decode(Wrap(new Proto.Event { MessagesSnapshot = snapshot })));
        var user = Assert.IsType<AGUIUserMessage>(decoded.Messages[0]);
        Assert.NotNull(user.Content.Value);
    }
}
