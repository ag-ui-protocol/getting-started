using AGUI.Abstractions;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

/// <summary>
/// The subagent events and <c>subagentId</c> over the binary transport (PNI-197). The
/// TypeScript encoder used to return a zero-length buffer for each SUBAGENT_* event and
/// to strip <c>subagentId</c> from everything else, so subagent support vanished silently
/// over protobuf while working over JSON.
/// </summary>
public sealed class SubagentRoundTripTest
{
    private static T RoundTrip<T>(T evt)
        where T : BaseEvent
    {
        var bytes = AGUIProtobuf.Encode(evt);
        Assert.NotEmpty(bytes.ToArray());
        var decoded = AGUIProtobuf.Decode(bytes);
        return Assert.IsType<T>(decoded);
    }

    [Fact]
    public void SubagentStarted_RoundTrips_WithEveryField()
    {
        var result = RoundTrip(new SubagentStartedEvent
        {
            SubagentId = "sub-1",
            Name = "researcher",
            Description = "digs through sources",
            ParentSubagentId = "sub-outer",
            ParentToolCallId = "call-9",
            ParentMessageId = "msg-3",
            Timestamp = 1234567890,
        });

        Assert.Equal("sub-1", result.SubagentId);
        Assert.Equal("researcher", result.Name);
        Assert.Equal("digs through sources", result.Description);
        Assert.Equal("sub-outer", result.ParentSubagentId);
        Assert.Equal("call-9", result.ParentToolCallId);
        Assert.Equal("msg-3", result.ParentMessageId);
        Assert.Equal(1234567890, result.Timestamp);
    }

    [Fact]
    public void SubagentStarted_RoundTrips_WithOnlyRequiredFields()
    {
        // Absent optionals must come back absent, not as empty strings: a consumer tells
        // a top-level subagent from a nested one by whether ParentSubagentId is null.
        var result = RoundTrip(new SubagentStartedEvent { SubagentId = "sub-1", Name = "researcher" });

        Assert.Equal("sub-1", result.SubagentId);
        Assert.Null(result.Description);
        Assert.Null(result.ParentSubagentId);
        Assert.Null(result.ParentToolCallId);
        Assert.Null(result.ParentMessageId);
    }

    [Fact]
    public void SubagentFinished_RoundTrips_WithAndWithoutResult()
    {
        var withResult = RoundTrip(new SubagentFinishedEvent
        {
            SubagentId = "sub-1",
            Result = JsonTestHelpers.Parse("{\"answer\":42}"),
        });

        Assert.Equal("sub-1", withResult.SubagentId);
        JsonTestHelpers.AssertEqual(JsonTestHelpers.Parse("{\"answer\":42}"), withResult.Result!.Value);

        var bare = RoundTrip(new SubagentFinishedEvent { SubagentId = "sub-1" });
        Assert.Null(bare.Result);
    }

    [Fact]
    public void SubagentError_RoundTrips_WithAndWithoutCode()
    {
        var withCode = RoundTrip(new SubagentErrorEvent
        {
            SubagentId = "sub-1",
            Message = "the subagent exploded",
            Code = "E_BOOM",
        });

        Assert.Equal("the subagent exploded", withCode.Message);
        Assert.Equal("E_BOOM", withCode.Code);

        var bare = RoundTrip(new SubagentErrorEvent { SubagentId = "sub-1", Message = "boom" });
        Assert.Null(bare.Code);
    }

    [Fact]
    public void SubagentId_SurvivesOnEveryAttributableEvent()
    {
        Assert.Equal("s1", RoundTrip(new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new TextMessageContentEvent { MessageId = "m1", Delta = "hi", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new TextMessageEndEvent { MessageId = "m1", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new ToolCallEndEvent { ToolCallId = "tc1", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new StepStartedEvent { StepName = "step", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new StepFinishedEvent { StepName = "step", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new CustomEvent { Name = "thing", SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new RawEvent { Event = JsonTestHelpers.Parse("{}"), SubagentId = "s1" }).SubagentId);
    }

    [Fact]
    public void SubagentId_StaysNullWhenAbsent()
    {
        // A round trip must not invent an empty-string attribution, or every parent event
        // would look like it came from a subagent whose id is "".
        Assert.Null(RoundTrip(new TextMessageStartEvent { MessageId = "m1", Role = "assistant" }).SubagentId);
        Assert.Null(RoundTrip(new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" }).SubagentId);
        Assert.Null(RoundTrip(new StepStartedEvent { StepName = "step" }).SubagentId);
    }

    [Fact]
    public void Messages_KeepPerMessageSubagentId_ThroughSnapshot()
    {
        // One snapshot mixes the parent's messages with every subagent's, so dropping the
        // field here would collapse all subagent groups into the parent thread.
        var snapshot = new MessagesSnapshotEvent();
        snapshot.Messages.Add(new AGUIAssistantMessage { Id = "m1", Content = "parent speaking" });
        snapshot.Messages.Add(new AGUIAssistantMessage { Id = "m2", Content = "subagent speaking", SubagentId = "sub-1" });
        snapshot.Messages.Add(new AGUIToolMessage { Id = "m3", Content = "done", ToolCallId = "tc1", SubagentId = "sub-2" });

        var result = RoundTrip(snapshot);

        Assert.Null(result.Messages[0].SubagentId);
        Assert.Equal("sub-1", result.Messages[1].SubagentId);
        Assert.Equal("sub-2", result.Messages[2].SubagentId);
    }

    [Fact]
    public void StateEvents_PreserveAttribution_SoNonConformanceStaysDiagnosable()
    {
        // Only the parent owns state, so a conforming producer never sets this. It is
        // mapped rather than dropped so an offending stream can still be diagnosed at the
        // consumer instead of losing the evidence on the wire — the client's stream
        // validation is what rejects it.
        Assert.Equal("s1", RoundTrip(new StateSnapshotEvent { Snapshot = JsonTestHelpers.Parse("{\"a\":1}"), SubagentId = "s1" }).SubagentId);
        Assert.Equal("s1", RoundTrip(new StateDeltaEvent { Delta = JsonTestHelpers.Parse("[]"), SubagentId = "s1" }).SubagentId);
    }

    [Fact]
    public void ParentMessageId_Null_StillDecodes()
    {
        // The interop regression PNI-200 warned about, pinned on the .NET side: the
        // Microsoft Agent Framework adapter's System.Text.Json emits
        // "parentMessageId": null, and a schema that rejected null aborted the run on the
        // first tool call. Nothing here may reintroduce that.
        var result = RoundTrip(new ToolCallStartEvent
        {
            ToolCallId = "tc1",
            ToolCallName = "search",
            ParentMessageId = null,
            SubagentId = "s1",
        });

        Assert.Null(result.ParentMessageId);
        Assert.Equal("s1", result.SubagentId);
    }
}
