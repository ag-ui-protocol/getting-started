using System;
using System.IO;
using AGUI.Abstractions;
using Xunit;
using Proto = AGUI.ProtocolBuffers;

namespace AGUI.Protobuf.UnitTests;

// Every schema event crosses the binary transport, since the wire mappers are
// generated from the same schema as the models. An envelope carrying a variant
// this build was not compiled against is the one remaining gap, and it decodes
// to an explicit unknown-event error rather than to some other event.
public sealed class UnsupportedEventTest
{
    public static TheoryData<BaseEvent> NewlyRepresentableEvents() => new()
    {
        new ReasoningStartEvent { MessageId = "m1" },
        new ReasoningEndEvent { MessageId = "m1" },
        new ReasoningMessageStartEvent { MessageId = "m1" },
        new ReasoningMessageContentEvent { MessageId = "m1", Delta = "d" },
        new ReasoningMessageEndEvent { MessageId = "m1" },
        new ReasoningMessageChunkEvent { MessageId = "m1", Delta = "d" },
        new ReasoningEncryptedValueEvent { Subtype = "message", EntityId = "m1", EncryptedValue = "v" },
        new ActivitySnapshotEvent { MessageId = "m1", ActivityType = "a", Content = JsonTestHelpers.Parse("{}") },
        new ActivityDeltaEvent { MessageId = "m1", ActivityType = "a", Patch = JsonTestHelpers.Parse("[]") },
        new ToolCallResultEvent { MessageId = "m1", ToolCallId = "c1", Content = "ok" },
        new TextMessageChunkEvent { MessageId = "m1", Delta = "d" },
        new ToolCallChunkEvent { ToolCallId = "c1", Delta = "{" },
    };

    [Theory]
    [MemberData(nameof(NewlyRepresentableEvents))]
    public void FormerlyUnsupportedEvent_RoundTrips(BaseEvent evt)
    {
        var decoded = AGUIProtobuf.Decode(AGUIProtobuf.Encode(evt));
        Assert.Equal(evt.Type, decoded.Type);
    }

    // Proto.Event is internal, so the theory parameterises by name and the
    // envelope is built inside the test body.
    private static Proto.Event SubagentEnvelope(string kind) => kind switch
    {
        "SUBAGENT_STARTED" => new Proto.Event
        {
            SubagentStarted = new Proto.SubagentStartedEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.SubagentStarted },
                SubagentRunId = "s1",
                Name = "researcher",
            },
        },
        "SUBAGENT_FINISHED" => new Proto.Event
        {
            SubagentFinished = new Proto.SubagentFinishedEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.SubagentFinished },
                SubagentRunId = "s1",
            },
        },
        _ => new Proto.Event
        {
            SubagentError = new Proto.SubagentErrorEvent
            {
                BaseEvent = new Proto.BaseEvent { Type = Proto.EventType.SubagentError },
                SubagentRunId = "s1",
                Message = "boom",
            },
        },
    };

    [Theory]
    [InlineData("SUBAGENT_STARTED")]
    [InlineData("SUBAGENT_FINISHED")]
    [InlineData("SUBAGENT_ERROR")]
    public void Decode_SubagentEvent_RoundTrips(string kind)
    {
        var bytes = Google.Protobuf.MessageExtensions.ToByteArray(SubagentEnvelope(kind));
        var decoded = AGUIProtobuf.Decode(bytes);
        Assert.Equal(kind, decoded.Type);
        var subagentRunId = decoded switch
        {
            SubagentStartedEvent started => started.SubagentRunId,
            SubagentFinishedEvent finished => finished.SubagentRunId,
            SubagentErrorEvent error => error.SubagentRunId,
            _ => null,
        };
        Assert.Equal("s1", subagentRunId);
    }

    // A newer producer's event reaches this build as an envelope whose only tag
    // is one this SDK was not compiled against: the oneof reads as unset, and
    // the frame is skippable because nothing about it is broken.
    [Fact]
    public void Decode_EnvelopeWithOnlyUnknownTags_ThrowsUnknownEventType()
    {
        // Field 900, length-delimited, empty payload: a variant far outside the
        // envelope this build knows.
        var bytes = new byte[] { 0xE2, 0x38, 0x00 };
        Assert.Throws<AGUIUnknownEventTypeException>(() => AGUIProtobuf.Decode(bytes));
    }

    // Malformed input is not an event from the future, and the two must not
    // share an answer: a reader may skip the unknown variant above, never these.
    [Fact]
    public void Decode_EmptyEnvelope_ThrowsInvalidData()
    {
        var bytes = Google.Protobuf.MessageExtensions.ToByteArray(new Proto.Event());
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
    }

    [Fact]
    public void Decode_KnownTagWithUnreadablePayload_ThrowsInvalidData()
    {
        // Envelope field 1 (TEXT_MESSAGE_START) carried as a varint rather than
        // a message: the parser cannot read it as the event the tag names, so
        // the oneof stays unset even though the envelope names a known event.
        var bytes = new byte[] { 0x08, 0x01 };
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
    }

    [Fact]
    public void Decode_KnownTagCarriedAsGroup_ThrowsInvalidData()
    {
        // Envelope field 1 as a start group, then its end group: a shape no
        // AG-UI encoder writes, and one the parser leaves the oneof unset for.
        // The envelope still names a known event, so it is broken input rather
        // than an event from the future.
        var bytes = new byte[] { 0x0B, 0x0C };
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
    }

    // Every event arm of the envelope is a length-delimited message, so an
    // unknown field of any other wire type is not an event this build has yet to
    // learn about — it is broken bytes, and skipping it would lose a real event.
    [Fact]
    public void Decode_UnknownVarintOnly_ThrowsInvalidData()
    {
        // Field 900, varint, value 1.
        var bytes = new byte[] { 0xE0, 0x38, 0x01 };
        Assert.Throws<InvalidDataException>(() => AGUIProtobuf.Decode(bytes));
    }

    [Fact]
    public void Encode_Null_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => AGUIProtobuf.Encode(null!));
    }
}
