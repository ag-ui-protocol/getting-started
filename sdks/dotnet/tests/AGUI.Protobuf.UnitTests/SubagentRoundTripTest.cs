using AGUI.Abstractions;
using Xunit;

namespace AGUI.Protobuf.UnitTests;

/// <summary>
/// The subagent events and <c>subagentRunId</c> over the binary transport (PNI-197). The
/// TypeScript encoder used to return a zero-length buffer for each SUBAGENT_* event and
/// to strip <c>subagentRunId</c> from everything else, so subagent support vanished silently
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
            SubagentRunId = "sub-1",
            Name = "researcher",
            Description = "digs through sources",
            ParentSubagentRunId = "sub-outer",
            ParentToolCallId = "call-9",
            ParentMessageId = "msg-3",
            Timestamp = 1234567890,
        });

        Assert.Equal("sub-1", result.SubagentRunId);
        Assert.Equal("researcher", result.Name);
        Assert.Equal("digs through sources", result.Description);
        Assert.Equal("sub-outer", result.ParentSubagentRunId);
        Assert.Equal("call-9", result.ParentToolCallId);
        Assert.Equal("msg-3", result.ParentMessageId);
        Assert.Equal(1234567890, result.Timestamp);
    }

    [Fact]
    public void SubagentStarted_RoundTrips_WithOnlyRequiredFields()
    {
        // Absent optionals must come back absent, not as empty strings: a consumer tells
        // a top-level subagent from a nested one by whether ParentSubagentRunId is null.
        var result = RoundTrip(new SubagentStartedEvent { SubagentRunId = "sub-1", Name = "researcher" });

        Assert.Equal("sub-1", result.SubagentRunId);
        Assert.Null(result.Description);
        Assert.Null(result.ParentSubagentRunId);
        Assert.Null(result.ParentToolCallId);
        Assert.Null(result.ParentMessageId);
    }

    [Fact]
    public void SubagentFinished_RoundTrips_WithAndWithoutResult()
    {
        var withResult = RoundTrip(new SubagentFinishedEvent
        {
            SubagentRunId = "sub-1",
            Result = JsonTestHelpers.Parse("{\"answer\":42}"),
        });

        Assert.Equal("sub-1", withResult.SubagentRunId);
        JsonTestHelpers.AssertEqual(JsonTestHelpers.Parse("{\"answer\":42}"), withResult.Result!.Value);

        var bare = RoundTrip(new SubagentFinishedEvent { SubagentRunId = "sub-1" });
        Assert.Null(bare.Result);
    }

    [Fact]
    public void SubagentFinished_RoundTrips_Outcomes()
    {
        // Legacy: no outcome comes back as no outcome.
        var legacy = RoundTrip(new SubagentFinishedEvent { SubagentRunId = "sub-1" });
        Assert.Null(legacy.Outcome);

        var success = RoundTrip(new SubagentFinishedEvent
        {
            SubagentRunId = "sub-1",
            Outcome = new SubagentFinishedSuccessOutcome(),
        });
        Assert.IsType<SubagentFinishedSuccessOutcome>(success.Outcome);

        var suspended = RoundTrip(new SubagentFinishedEvent
        {
            SubagentRunId = "sub-1",
            Outcome = new SubagentFinishedSuspendedOutcome
            {
                InterruptIds = new List<string> { "int-1", "int-2" },
            },
        });
        var suspendedOutcome = Assert.IsType<SubagentFinishedSuspendedOutcome>(suspended.Outcome);
        Assert.Equal(new[] { "int-1", "int-2" }, suspendedOutcome.InterruptIds);

        // An ancestor suspended by a descendant owns no interrupts itself.
        var ancestor = RoundTrip(new SubagentFinishedEvent
        {
            SubagentRunId = "sub-outer",
            Outcome = new SubagentFinishedSuspendedOutcome(),
        });
        var ancestorOutcome = Assert.IsType<SubagentFinishedSuspendedOutcome>(ancestor.Outcome);
        Assert.Null(ancestorOutcome.InterruptIds);
    }

    [Fact]
    public void Interrupt_SubagentRunId_SurvivesTheRunFinishedOutcome()
    {
        var result = RoundTrip(new RunFinishedEvent
        {
            ThreadId = "t1",
            RunId = "r1",
            Outcome = new RunFinishedInterruptOutcome
            {
                Interrupts =
                {
                    new AGUIInterrupt { Id = "int-1", Reason = "hitl", SubagentRunId = "tools:s1" },
                    new AGUIInterrupt { Id = "int-2", Reason = "hitl" },
                },
            },
        });

        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(result.Outcome);
        Assert.Equal("tools:s1", outcome.Interrupts[0].SubagentRunId);
        Assert.Null(outcome.Interrupts[1].SubagentRunId);
    }

    [Fact]
    public void SubagentError_RoundTrips_WithAndWithoutCode()
    {
        var withCode = RoundTrip(new SubagentErrorEvent
        {
            SubagentRunId = "sub-1",
            Message = "the subagent exploded",
            Code = "E_BOOM",
        });

        Assert.Equal("the subagent exploded", withCode.Message);
        Assert.Equal("E_BOOM", withCode.Code);

        var bare = RoundTrip(new SubagentErrorEvent { SubagentRunId = "sub-1", Message = "boom" });
        Assert.Null(bare.Code);
    }

    [Fact]
    public void SubagentRunId_SurvivesOnEveryAttributableEvent()
    {
        Assert.Equal("s1", RoundTrip(new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new TextMessageContentEvent { MessageId = "m1", Delta = "hi", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new StepStartedEvent { StepName = "step", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new StepFinishedEvent { StepName = "step", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new CustomEvent { Name = "thing", SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new RawEvent { Event = JsonTestHelpers.Parse("{}"), SubagentRunId = "s1" }).SubagentRunId);
    }

    [Fact]
    public void SubagentRunId_StaysNullWhenAbsent()
    {
        // A round trip must not invent an empty-string attribution, or every parent event
        // would look like it came from a subagent whose id is "".
        Assert.Null(RoundTrip(new TextMessageStartEvent { MessageId = "m1", Role = "assistant" }).SubagentRunId);
        Assert.Null(RoundTrip(new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" }).SubagentRunId);
        Assert.Null(RoundTrip(new StepStartedEvent { StepName = "step" }).SubagentRunId);
    }

    [Fact]
    public void Messages_KeepPerMessageSubagentRunId_ThroughSnapshot()
    {
        // One snapshot mixes the parent's messages with every subagent's, so dropping the
        // field here would collapse all subagent groups into the parent thread.
        var snapshot = new MessagesSnapshotEvent();
        snapshot.Messages.Add(new AGUIAssistantMessage { Id = "m1", Content = "parent speaking" });
        snapshot.Messages.Add(new AGUIAssistantMessage { Id = "m2", Content = "subagent speaking", SubagentRunId = "sub-1" });
        snapshot.Messages.Add(new AGUIToolMessage { Id = "m3", Content = "done", ToolCallId = "tc1", SubagentRunId = "sub-2" });

        var result = RoundTrip(snapshot);

        Assert.Null(result.Messages[0].SubagentRunId);
        Assert.Equal("sub-1", result.Messages[1].SubagentRunId);
        Assert.Equal("sub-2", result.Messages[2].SubagentRunId);
    }

    [Fact]
    public void SubagentStarted_WithoutItsRequiredFields_FailsWithADescriptiveMessage()
    {
        // The generated protobuf setters reject null with a bare ArgumentNullException
        // naming only "value", which says nothing about which event or field was at fault.
        // These properties are nullable so a MISSING value stays distinguishable from an
        // explicit "" (see the client's RequireProvided), which means null reaches the
        // encoder and has to be reported here.
        var missingId = Assert.Throws<InvalidOperationException>(
            () => AGUIProtobuf.Encode(new SubagentStartedEvent { Name = "researcher" }));
        Assert.Equal("Cannot encode 'SUBAGENT_STARTED': 'subagentRunId' is required.", missingId.Message);

        var missingName = Assert.Throws<InvalidOperationException>(
            () => AGUIProtobuf.Encode(new SubagentStartedEvent { SubagentRunId = "s1" }));
        Assert.Equal("Cannot encode 'SUBAGENT_STARTED': 'name' is required.", missingName.Message);
    }

    [Fact]
    public void SubagentFinished_WithoutItsRequiredField_FailsWithADescriptiveMessage()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => AGUIProtobuf.Encode(new SubagentFinishedEvent()));
        Assert.Equal("Cannot encode 'SUBAGENT_FINISHED': 'subagentRunId' is required.", ex.Message);
    }

    [Fact]
    public void SubagentError_WithoutItsRequiredFields_FailsWithADescriptiveMessage()
    {
        var missingId = Assert.Throws<InvalidOperationException>(
            () => AGUIProtobuf.Encode(new SubagentErrorEvent { Message = "boom" }));
        Assert.Equal("Cannot encode 'SUBAGENT_ERROR': 'subagentRunId' is required.", missingId.Message);

        var missingMessage = Assert.Throws<InvalidOperationException>(
            () => AGUIProtobuf.Encode(new SubagentErrorEvent { SubagentRunId = "s1" }));
        Assert.Equal("Cannot encode 'SUBAGENT_ERROR': 'message' is required.", missingMessage.Message);
    }

    [Fact]
    public void EmptyRequiredFields_StillEncode()
    {
        // The control for the three tests above: "" is a value the schemas accept, so only
        // an ABSENT field is an error. Rejecting empty here would make .NET stricter than
        // TypeScript and Python.
        var result = RoundTrip(new SubagentStartedEvent { SubagentRunId = "", Name = "" });
        Assert.Equal("", result.SubagentRunId);
        Assert.Equal("", result.Name);
    }

    [Fact]
    public void StateEvents_PreserveAttribution_SoNonConformanceStaysDiagnosable()
    {
        // Attribution on a state event records which subagent PRODUCED the update; the
        // state itself stays run-scoped and is applied run-scoped. The client accepts these
        // streams, so this is ordinary provenance rather than evidence of a fault — mapping
        // it keeps the producer identifiable end to end instead of dropping it on the wire.
        Assert.Equal("s1", RoundTrip(new StateSnapshotEvent { Snapshot = JsonTestHelpers.Parse("{\"a\":1}"), SubagentRunId = "s1" }).SubagentRunId);
        Assert.Equal("s1", RoundTrip(new StateDeltaEvent { Delta = JsonTestHelpers.Parse("[]"), SubagentRunId = "s1" }).SubagentRunId);
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
            SubagentRunId = "s1",
        });

        Assert.Null(result.ParentMessageId);
        Assert.Equal("s1", result.SubagentRunId);
    }
}
