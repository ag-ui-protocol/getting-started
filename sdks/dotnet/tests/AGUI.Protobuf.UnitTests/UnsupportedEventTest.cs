using System;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

public sealed class UnsupportedEventTest
{
    public static TheoryData<BaseEvent> UnsupportedEvents() => new()
    {
        new ReasoningStartEvent(),
        new ReasoningEndEvent(),
        new ReasoningMessageStartEvent(),
        new ReasoningMessageContentEvent(),
        new ReasoningMessageEndEvent(),
        new ActivitySnapshotEvent(),
        new ActivityDeltaEvent(),
        new ToolCallResultEvent(),
    };

    [Theory]
    [MemberData(nameof(UnsupportedEvents))]
    public void Encode_UnsupportedEvent_Throws(BaseEvent evt)
    {
        var exception = Assert.Throws<NotSupportedException>(() => AGUIProtobuf.Encode(evt));
        Assert.Contains(evt.Type, exception.Message);
    }

    [Fact]
    public void Encode_Null_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => AGUIProtobuf.Encode(null!));
    }
}
