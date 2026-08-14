using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// The three subagent lifecycle events and the <c>subagentRunId</c> attribution field.
/// Before these existed the .NET SDK had no way to express delegated work at all, which
/// is what kept the 31-event set incomplete.
/// </summary>
public sealed class SubagentEventTest
{
    [Fact]
    public void SubagentStarted_Serialize_IncludesAllFields()
    {
        var evt = new SubagentStartedEvent
        {
            SubagentRunId = "sub-1",
            Name = "researcher",
            Description = "digs through sources",
            ParentSubagentRunId = "sub-outer",
            ParentToolCallId = "call-9",
            ParentMessageId = "msg-3",
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.SubagentStartedEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("SUBAGENT_STARTED", root.GetProperty("type").GetString());
        Assert.Equal("sub-1", root.GetProperty("subagentRunId").GetString());
        Assert.Equal("researcher", root.GetProperty("name").GetString());
        Assert.Equal("digs through sources", root.GetProperty("description").GetString());
        Assert.Equal("sub-outer", root.GetProperty("parentSubagentRunId").GetString());
        Assert.Equal("call-9", root.GetProperty("parentToolCallId").GetString());
        Assert.Equal("msg-3", root.GetProperty("parentMessageId").GetString());
    }

    [Fact]
    public void SubagentStarted_OmitsAbsentOptionals()
    {
        // Absent must mean absent on the wire, not null: a consumer distinguishes "no
        // parent" (top-level subagent) from "parent with an empty id", and the TypeScript
        // schema treats a present-but-null differently from omitted.
        var evt = new SubagentStartedEvent { SubagentRunId = "sub-1", Name = "researcher" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.SubagentStartedEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.False(root.TryGetProperty("description", out _));
        Assert.False(root.TryGetProperty("parentSubagentRunId", out _));
        Assert.False(root.TryGetProperty("parentToolCallId", out _));
        Assert.False(root.TryGetProperty("parentMessageId", out _));
    }

    [Fact]
    public void SubagentFinished_RoundTripsWithAndWithoutResult()
    {
        var withResult = new SubagentFinishedEvent
        {
            SubagentRunId = "sub-1",
            Result = JsonSerializer.Deserialize<JsonElement>("{\"answer\":42}"),
        };

        var json = JsonSerializer.Serialize(withResult, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);

        Assert.NotNull(back);
        Assert.Equal("sub-1", back.SubagentRunId);
        Assert.NotNull(back.Result);
        Assert.Equal(42, back.Result!.Value.GetProperty("answer").GetInt32());

        var bare = new SubagentFinishedEvent { SubagentRunId = "sub-1" };
        var bareJson = JsonSerializer.Serialize(bare, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        using var doc = JsonDocument.Parse(bareJson);
        Assert.False(doc.RootElement.TryGetProperty("result", out _));
    }

    [Fact]
    public void SubagentFinished_RoundTripsOutcomes()
    {
        // Legacy: no outcome serializes without the property and reads back null.
        var legacy = new SubagentFinishedEvent { SubagentRunId = "sub-1" };
        var legacyJson = JsonSerializer.Serialize(legacy, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        using (var doc = JsonDocument.Parse(legacyJson))
        {
            Assert.False(doc.RootElement.TryGetProperty("outcome", out _));
        }

        var suspended = new SubagentFinishedEvent
        {
            SubagentRunId = "sub-1",
            Outcome = new SubagentFinishedSuspendedOutcome { InterruptIds = new List<string> { "int-1" } },
        };
        var json = JsonSerializer.Serialize(suspended, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        Assert.Contains("\"suspended\"", json, StringComparison.Ordinal);
        Assert.Contains("\"interruptIds\"", json, StringComparison.Ordinal);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        var suspendedBack = Assert.IsType<SubagentFinishedSuspendedOutcome>(back!.Outcome);
        Assert.Equal(new[] { "int-1" }, suspendedBack.InterruptIds);

        var success = new SubagentFinishedEvent
        {
            SubagentRunId = "sub-1",
            Outcome = new SubagentFinishedSuccessOutcome(),
        };
        var successJson = JsonSerializer.Serialize(success, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        var successBack = JsonSerializer.Deserialize(successJson, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        Assert.IsType<SubagentFinishedSuccessOutcome>(successBack!.Outcome);
    }

    [Fact]
    public void Interrupt_CarriesTheRaisingSubagent()
    {
        var owned = new AGUIInterrupt { Id = "int-1", Reason = "hitl", SubagentRunId = "tools:s1" };
        var json = JsonSerializer.Serialize(owned, AGUIJsonSerializerContext.Default.AGUIInterrupt);
        Assert.Contains("\"subagentRunId\":\"tools:s1\"", json, StringComparison.Ordinal);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIInterrupt);
        Assert.Equal("tools:s1", back!.SubagentRunId);

        var root = new AGUIInterrupt { Id = "int-2", Reason = "hitl" };
        var rootJson = JsonSerializer.Serialize(root, AGUIJsonSerializerContext.Default.AGUIInterrupt);
        Assert.DoesNotContain("subagentRunId", rootJson, StringComparison.Ordinal);
    }

    [Fact]
    public void SubagentError_RoundTripsWithAndWithoutCode()
    {
        var evt = new SubagentErrorEvent
        {
            SubagentRunId = "sub-1",
            Message = "the subagent exploded",
            Code = "E_BOOM",
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.SubagentErrorEvent);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.SubagentErrorEvent);

        Assert.NotNull(back);
        Assert.Equal("the subagent exploded", back.Message);
        Assert.Equal("E_BOOM", back.Code);

        var bare = new SubagentErrorEvent { SubagentRunId = "sub-1", Message = "boom" };
        var bareJson = JsonSerializer.Serialize(bare, AGUIJsonSerializerContext.Default.SubagentErrorEvent);
        using var doc = JsonDocument.Parse(bareJson);
        Assert.False(doc.RootElement.TryGetProperty("code", out _));
    }

    [Theory]
    [InlineData("{\"type\":\"SUBAGENT_STARTED\",\"subagentRunId\":\"s\",\"name\":\"n\"}", typeof(SubagentStartedEvent))]
    [InlineData("{\"type\":\"SUBAGENT_FINISHED\",\"subagentRunId\":\"s\"}", typeof(SubagentFinishedEvent))]
    [InlineData("{\"type\":\"SUBAGENT_ERROR\",\"subagentRunId\":\"s\",\"message\":\"m\"}", typeof(SubagentErrorEvent))]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType(string json, System.Type expected)
    {
        // The polymorphic converter is how events arrive off the wire. An unmapped
        // discriminator throws, so this is what proves the three are actually reachable
        // rather than merely declared.
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.NotNull(evt);
        Assert.IsType(expected, evt);
    }

    [Fact]
    public void Serialize_ViaBaseEvent_KeepsDiscriminator()
    {
        // Exercises the converter's Write path: a missing case there silently drops the
        // event's own fields.
        BaseEvent evt = new SubagentStartedEvent { SubagentRunId = "sub-1", Name = "researcher" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("SUBAGENT_STARTED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("sub-1", doc.RootElement.GetProperty("subagentRunId").GetString());
        Assert.Equal("researcher", doc.RootElement.GetProperty("name").GetString());
    }
}

/// <summary>
/// Attribution on every event path a subagent can produce, and on the message model.
/// </summary>
public sealed class SubagentAttributionTest
{
    [Fact]
    public void TextEvents_CarrySubagentRunId()
    {
        AssertRoundTrips(new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new TextMessageContentEvent { MessageId = "m1", Delta = "hi", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" }, e => e.SubagentRunId);
    }

    [Fact]
    public void ToolCallEvents_CarrySubagentRunId()
    {
        AssertRoundTrips(new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new ToolCallResultEvent { MessageId = "m1", ToolCallId = "tc1", Content = "done", SubagentRunId = "s1" }, e => e.SubagentRunId);
    }

    [Fact]
    public void ReasoningEvents_CarrySubagentRunId()
    {
        AssertRoundTrips(new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new ReasoningMessageStartEvent { MessageId = "r1", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new ReasoningMessageContentEvent { MessageId = "r1", Delta = "think", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new ReasoningMessageEndEvent { MessageId = "r1", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new ReasoningEndEvent { MessageId = "r1", SubagentRunId = "s1" }, e => e.SubagentRunId);
        // Encrypted reasoning is called out separately because it was the one path the
        // LangGraph integration silently failed to attribute (PNI-195).
        AssertRoundTrips(
            new ReasoningEncryptedValueEvent { Subtype = "message", EntityId = "r1", EncryptedValue = "opaque", SubagentRunId = "s1" },
            e => e.SubagentRunId);
    }

    [Fact]
    public void ActivityAndStepEvents_CarrySubagentRunId()
    {
        AssertRoundTrips(new StepStartedEvent { StepName = "step", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(new StepFinishedEvent { StepName = "step", SubagentRunId = "s1" }, e => e.SubagentRunId);
        AssertRoundTrips(
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = JsonSerializer.Deserialize<JsonElement>("{}"), SubagentRunId = "s1" },
            e => e.SubagentRunId);
    }

    [Fact]
    public void SubagentRunId_IsOmittedWhenAbsent()
    {
        // Unattributed events belong to the parent. Emitting an explicit null would make
        // every parent event carry the key, which the TypeScript schema and the protobuf
        // optional both treat as different from omitted.
        var json = JsonSerializer.Serialize(
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        using var doc = JsonDocument.Parse(json);
        Assert.False(doc.RootElement.TryGetProperty("subagentRunId", out _));
    }

    [Fact]
    public void Messages_CarrySubagentRunIdOnEveryRole()
    {
        // Declared on AGUIMessage rather than per role: one MESSAGES_SNAPSHOT mixes the
        // parent's messages with every subagent's, so attribution travels per message.
        var messages = new List<AGUIMessage>
        {
            new AGUIAssistantMessage { Id = "m1", Content = "hi", SubagentRunId = "s1" },
            new AGUIToolMessage { Id = "m2", Content = "done", ToolCallId = "tc1", SubagentRunId = "s1" },
            new AGUIReasoningMessage { Id = "m3", Content = "think", SubagentRunId = "s2" },
            new AGUIUserMessage { Id = "m4", Content = new AGUIUserContent("hello"), SubagentRunId = "s3" },
        };

        var snapshot = new MessagesSnapshotEvent();
        foreach (var message in messages)
        {
            snapshot.Messages.Add(message);
        }

        var json = JsonSerializer.Serialize(snapshot, AGUIJsonSerializerContext.Default.MessagesSnapshotEvent);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.MessagesSnapshotEvent);

        Assert.NotNull(back);
        Assert.Equal(new[] { "s1", "s1", "s2", "s3" }, back.Messages.Select(m => m.SubagentRunId).ToArray());
    }

    [Fact]
    public void Messages_OmitSubagentRunIdWhenAbsent()
    {
        var json = JsonSerializer.Serialize(
            (AGUIMessage)new AGUIAssistantMessage { Id = "m1", Content = "hi" },
            AGUIJsonSerializerContext.Default.AGUIMessage);

        using var doc = JsonDocument.Parse(json);
        Assert.False(doc.RootElement.TryGetProperty("subagentRunId", out _));
    }

    [Fact]
    public void SubagentRunId_SurvivesTheChatMessageRoundTrip()
    {
        // AGUIChatClient sends request messages through AsAGUIMessages, so anything
        // this round trip drops is silently reattributed to the parent on the next
        // turn. ChatMessage has no concept of delegated work, hence the
        // AdditionalProperties carriage — the same approach the binary content parts
        // already use for their AG-UI-only "filename".
        var original = new List<AGUIMessage>
        {
            new AGUIAssistantMessage { Id = "m1", Content = "from a subagent", SubagentRunId = "s1" },
            new AGUIToolMessage { Id = "m2", Content = "done", ToolCallId = "tc1", SubagentRunId = "s2" },
            new AGUIUserMessage { Id = "m3", Content = new AGUIUserContent("hi"), SubagentRunId = "s3" },
            new AGUIAssistantMessage { Id = "m4", Content = "from the parent" },
        };

        var back = original.AsChatMessages().AsAGUIMessages().ToList();

        var byId = back.ToDictionary(m => m.Id!, m => m.SubagentRunId);
        Assert.Equal("s1", byId["m1"]);
        Assert.Equal("s3", byId["m3"]);
        Assert.Null(byId["m4"]);
        // A tool message is deliberately rekeyed to its call id on the way back (see
        // the ChatRole.Tool branch, which mirrors Microsoft.Extensions.AI by
        // materializing one message per FunctionResultContent), so it returns as "tc1"
        // rather than "m2". Its attribution still has to survive.
        Assert.Equal("s2", byId["tc1"]);
    }

    [Fact]
    public void EmptySubagentRunId_SurvivesTheRoundTrip()
    {
        // An empty string is a valid opaque id — the schemas accept it — so treating it as
        // absent silently converted it to parent attribution on the next turn.
        var back = new List<AGUIMessage>
        {
            new AGUIAssistantMessage { Id = "m1", Content = "hi", SubagentRunId = "" },
        }.AsChatMessages().AsAGUIMessages().ToList();

        Assert.Equal("", Assert.Single(back).SubagentRunId);
    }

    [Fact]
    public void ParallelCallsFromDifferentSubagents_KeepProviderValidGroupingAndLoseTheSecondOwner()
    {
        // Pins CURRENT behaviour, which is a limitation rather than a settled design: the run
        // is merged, so the first owner wins and the second is lost.
        //
        // The provider constraint (microsoft/agent-framework#2699) is adjacency — an
        // assistant tool_calls message must be immediately followed by its own results — so
        // interleaving would satisfy it as well as merging does, and would keep both owners.
        // Splitting on owner change was reverted only because it split without reordering
        // the results, producing the invalid shape. See PNI-293; if that lands, this test
        // should be replaced rather than kept.
        var chatMessages = new List<AGUIMessage>
        {
            new AGUIAssistantMessage
            {
                Id = "m1",
                SubagentRunId = "s1",
                ToolCalls = new List<AGUIToolCall>
                {
                    new() { Id = "tc1", Type = "function", Function = new AGUIToolCallFunction { Name = "search", Arguments = "{}" } },
                },
            },
            new AGUIAssistantMessage
            {
                Id = "m2",
                SubagentRunId = "s2",
                ToolCalls = new List<AGUIToolCall>
                {
                    new() { Id = "tc2", Type = "function", Function = new AGUIToolCallFunction { Name = "write", Arguments = "{}" } },
                },
            },
        }.AsChatMessages().ToList();

        // One assistant message holding both calls: the shape providers require.
        var merged = Assert.Single(chatMessages);
        Assert.Equal(
            new[] { "tc1", "tc2" },
            merged.Contents.OfType<FunctionCallContent>().Select(c => c.CallId).ToArray());

        // Carrying the first owner; s2's attribution is the acknowledged casualty.
        Assert.Equal(
            "s1",
            merged.AdditionalProperties?.TryGetValue("agui.subagentRunId", out string? v) == true ? v : null);
    }

    [Fact]
    public void ParentFirstParallelCalls_StayParentOwned()
    {
        // The FIRST owner in the run wins, and the parent is an owner like any subagent. A
        // "first non-null owner wins" capture promoted s2 onto a run the parent opened, so
        // the merged message — including the parent's own tool call — came back attributed
        // to a subagent that never made it. Losing s2's attribution is the acknowledged
        // limitation above; inventing an owner for the parent's call is not.
        var chatMessages = new List<AGUIMessage>
        {
            new AGUIAssistantMessage
            {
                Id = "m1",
                ToolCalls = new List<AGUIToolCall>
                {
                    new() { Id = "tc1", Type = "function", Function = new AGUIToolCallFunction { Name = "search", Arguments = "{}" } },
                },
            },
            new AGUIAssistantMessage
            {
                Id = "m2",
                SubagentRunId = "s2",
                ToolCalls = new List<AGUIToolCall>
                {
                    new() { Id = "tc2", Type = "function", Function = new AGUIToolCallFunction { Name = "write", Arguments = "{}" } },
                },
            },
        }.AsChatMessages().ToList();

        var merged = Assert.Single(chatMessages);
        Assert.Equal(
            new[] { "tc1", "tc2" },
            merged.Contents.OfType<FunctionCallContent>().Select(c => c.CallId).ToArray());
        Assert.False(merged.AdditionalProperties?.ContainsKey("agui.subagentRunId") == true);
    }

    [Fact]
    public void ToolCallRunOwner_IsCapturedAfreshAfterAFlush()
    {
        // The capture flag is per run, so the run a non-tool-call message ends must not
        // carry its owner into the next one: here the parent's run flushes, then s1 opens a
        // new run that has to be attributed to s1.
        var chatMessages = new List<AGUIMessage>
        {
            new AGUIAssistantMessage
            {
                Id = "m1",
                ToolCalls = new List<AGUIToolCall>
                {
                    new() { Id = "tc1", Type = "function", Function = new AGUIToolCallFunction { Name = "search", Arguments = "{}" } },
                },
            },
            new AGUIToolMessage { Id = "t1", ToolCallId = "tc1", Content = "done" },
            new AGUIAssistantMessage
            {
                Id = "m2",
                SubagentRunId = "s1",
                ToolCalls = new List<AGUIToolCall>
                {
                    new() { Id = "tc2", Type = "function", Function = new AGUIToolCallFunction { Name = "write", Arguments = "{}" } },
                },
            },
        }.AsChatMessages().ToList();

        var parentRun = chatMessages[0];
        Assert.False(parentRun.AdditionalProperties?.ContainsKey("agui.subagentRunId") == true);

        var subagentRun = chatMessages[2];
        Assert.Equal(
            "s1",
            subagentRun.AdditionalProperties?.TryGetValue("agui.subagentRunId", out string? v) == true ? v : null);
    }

    [Fact]
    public void UnattributedMessages_DoNotGainAnAdditionalProperty()
    {
        // A parent-owned message must not acquire the key at all, or every consumer
        // inspecting AdditionalProperties sees delegation where there is none.
        var chatMessages = new List<AGUIMessage>
        {
            new AGUIAssistantMessage { Id = "m1", Content = "from the parent" },
        }.AsChatMessages().ToList();

        var message = Assert.Single(chatMessages);
        Assert.True(
            message.AdditionalProperties is null
                || !message.AdditionalProperties.ContainsKey("agui.subagentRunId"));
    }

    private static void AssertRoundTrips<T>(T evt, System.Func<T, string?> read)
        where T : BaseEvent
    {
        // Goes through the polymorphic BaseEvent converter, so a Write or Read case that
        // forgot this event type fails here rather than passing on a direct serialize.
        var json = JsonSerializer.Serialize((BaseEvent)evt, AGUIJsonSerializerContext.Default.BaseEvent);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.NotNull(back);
        var typed = Assert.IsType<T>(back);
        Assert.Equal("s1", read(typed));
    }
}
