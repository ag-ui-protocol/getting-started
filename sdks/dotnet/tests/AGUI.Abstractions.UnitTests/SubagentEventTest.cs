using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// The three subagent lifecycle events and the <c>subagentId</c> attribution field.
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
            SubagentId = "sub-1",
            Name = "researcher",
            Description = "digs through sources",
            ParentSubagentId = "sub-outer",
            ParentToolCallId = "call-9",
            ParentMessageId = "msg-3",
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.SubagentStartedEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("SUBAGENT_STARTED", root.GetProperty("type").GetString());
        Assert.Equal("sub-1", root.GetProperty("subagentId").GetString());
        Assert.Equal("researcher", root.GetProperty("name").GetString());
        Assert.Equal("digs through sources", root.GetProperty("description").GetString());
        Assert.Equal("sub-outer", root.GetProperty("parentSubagentId").GetString());
        Assert.Equal("call-9", root.GetProperty("parentToolCallId").GetString());
        Assert.Equal("msg-3", root.GetProperty("parentMessageId").GetString());
    }

    [Fact]
    public void SubagentStarted_OmitsAbsentOptionals()
    {
        // Absent must mean absent on the wire, not null: a consumer distinguishes "no
        // parent" (top-level subagent) from "parent with an empty id", and the TypeScript
        // schema treats a present-but-null differently from omitted.
        var evt = new SubagentStartedEvent { SubagentId = "sub-1", Name = "researcher" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.SubagentStartedEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.False(root.TryGetProperty("description", out _));
        Assert.False(root.TryGetProperty("parentSubagentId", out _));
        Assert.False(root.TryGetProperty("parentToolCallId", out _));
        Assert.False(root.TryGetProperty("parentMessageId", out _));
    }

    [Fact]
    public void SubagentFinished_RoundTripsWithAndWithoutResult()
    {
        var withResult = new SubagentFinishedEvent
        {
            SubagentId = "sub-1",
            Result = JsonSerializer.Deserialize<JsonElement>("{\"answer\":42}"),
        };

        var json = JsonSerializer.Serialize(withResult, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);

        Assert.NotNull(back);
        Assert.Equal("sub-1", back.SubagentId);
        Assert.NotNull(back.Result);
        Assert.Equal(42, back.Result!.Value.GetProperty("answer").GetInt32());

        var bare = new SubagentFinishedEvent { SubagentId = "sub-1" };
        var bareJson = JsonSerializer.Serialize(bare, AGUIJsonSerializerContext.Default.SubagentFinishedEvent);
        using var doc = JsonDocument.Parse(bareJson);
        Assert.False(doc.RootElement.TryGetProperty("result", out _));
    }

    [Fact]
    public void SubagentError_RoundTripsWithAndWithoutCode()
    {
        var evt = new SubagentErrorEvent
        {
            SubagentId = "sub-1",
            Message = "the subagent exploded",
            Code = "E_BOOM",
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.SubagentErrorEvent);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.SubagentErrorEvent);

        Assert.NotNull(back);
        Assert.Equal("the subagent exploded", back.Message);
        Assert.Equal("E_BOOM", back.Code);

        var bare = new SubagentErrorEvent { SubagentId = "sub-1", Message = "boom" };
        var bareJson = JsonSerializer.Serialize(bare, AGUIJsonSerializerContext.Default.SubagentErrorEvent);
        using var doc = JsonDocument.Parse(bareJson);
        Assert.False(doc.RootElement.TryGetProperty("code", out _));
    }

    [Theory]
    [InlineData("{\"type\":\"SUBAGENT_STARTED\",\"subagentId\":\"s\",\"name\":\"n\"}", typeof(SubagentStartedEvent))]
    [InlineData("{\"type\":\"SUBAGENT_FINISHED\",\"subagentId\":\"s\"}", typeof(SubagentFinishedEvent))]
    [InlineData("{\"type\":\"SUBAGENT_ERROR\",\"subagentId\":\"s\",\"message\":\"m\"}", typeof(SubagentErrorEvent))]
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
        BaseEvent evt = new SubagentStartedEvent { SubagentId = "sub-1", Name = "researcher" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("SUBAGENT_STARTED", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("sub-1", doc.RootElement.GetProperty("subagentId").GetString());
        Assert.Equal("researcher", doc.RootElement.GetProperty("name").GetString());
    }
}

/// <summary>
/// Attribution on every event path a subagent can produce, and on the message model.
/// </summary>
public sealed class SubagentAttributionTest
{
    [Fact]
    public void TextEvents_CarrySubagentId()
    {
        AssertRoundTrips(new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new TextMessageContentEvent { MessageId = "m1", Delta = "hi", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new TextMessageEndEvent { MessageId = "m1", SubagentId = "s1" }, e => e.SubagentId);
    }

    [Fact]
    public void ToolCallEvents_CarrySubagentId()
    {
        AssertRoundTrips(new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new ToolCallEndEvent { ToolCallId = "tc1", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new ToolCallResultEvent { MessageId = "m1", ToolCallId = "tc1", Content = "done", SubagentId = "s1" }, e => e.SubagentId);
    }

    [Fact]
    public void ReasoningEvents_CarrySubagentId()
    {
        AssertRoundTrips(new ReasoningStartEvent { MessageId = "r1", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new ReasoningMessageStartEvent { MessageId = "r1", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new ReasoningMessageContentEvent { MessageId = "r1", Delta = "think", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new ReasoningMessageEndEvent { MessageId = "r1", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new ReasoningEndEvent { MessageId = "r1", SubagentId = "s1" }, e => e.SubagentId);
        // Encrypted reasoning is called out separately because it was the one path the
        // LangGraph integration silently failed to attribute (PNI-195).
        AssertRoundTrips(
            new ReasoningEncryptedValueEvent { Subtype = "message", EntityId = "r1", EncryptedValue = "opaque", SubagentId = "s1" },
            e => e.SubagentId);
    }

    [Fact]
    public void ActivityAndStepEvents_CarrySubagentId()
    {
        AssertRoundTrips(new StepStartedEvent { StepName = "step", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(new StepFinishedEvent { StepName = "step", SubagentId = "s1" }, e => e.SubagentId);
        AssertRoundTrips(
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = JsonSerializer.Deserialize<JsonElement>("{}"), SubagentId = "s1" },
            e => e.SubagentId);
    }

    [Fact]
    public void SubagentId_IsOmittedWhenAbsent()
    {
        // Unattributed events belong to the parent. Emitting an explicit null would make
        // every parent event carry the key, which the TypeScript schema and the protobuf
        // optional both treat as different from omitted.
        var json = JsonSerializer.Serialize(
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        using var doc = JsonDocument.Parse(json);
        Assert.False(doc.RootElement.TryGetProperty("subagentId", out _));
    }

    [Fact]
    public void Messages_CarrySubagentIdOnEveryRole()
    {
        // Declared on AGUIMessage rather than per role: one MESSAGES_SNAPSHOT mixes the
        // parent's messages with every subagent's, so attribution travels per message.
        var messages = new List<AGUIMessage>
        {
            new AGUIAssistantMessage { Id = "m1", Content = "hi", SubagentId = "s1" },
            new AGUIToolMessage { Id = "m2", Content = "done", ToolCallId = "tc1", SubagentId = "s1" },
            new AGUIReasoningMessage { Id = "m3", Content = "think", SubagentId = "s2" },
            new AGUIUserMessage { Id = "m4", Content = new AGUIUserContent("hello"), SubagentId = "s3" },
        };

        var snapshot = new MessagesSnapshotEvent();
        foreach (var message in messages)
        {
            snapshot.Messages.Add(message);
        }

        var json = JsonSerializer.Serialize(snapshot, AGUIJsonSerializerContext.Default.MessagesSnapshotEvent);
        var back = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.MessagesSnapshotEvent);

        Assert.NotNull(back);
        Assert.Equal(new[] { "s1", "s1", "s2", "s3" }, back.Messages.Select(m => m.SubagentId).ToArray());
    }

    [Fact]
    public void Messages_OmitSubagentIdWhenAbsent()
    {
        var json = JsonSerializer.Serialize(
            (AGUIMessage)new AGUIAssistantMessage { Id = "m1", Content = "hi" },
            AGUIJsonSerializerContext.Default.AGUIMessage);

        using var doc = JsonDocument.Parse(json);
        Assert.False(doc.RootElement.TryGetProperty("subagentId", out _));
    }

    [Fact]
    public void SubagentId_SurvivesTheChatMessageRoundTrip()
    {
        // AGUIChatClient sends request messages through AsAGUIMessages, so anything
        // this round trip drops is silently reattributed to the parent on the next
        // turn. ChatMessage has no concept of delegated work, hence the
        // AdditionalProperties carriage — the same approach the binary content parts
        // already use for their AG-UI-only "filename".
        var original = new List<AGUIMessage>
        {
            new AGUIAssistantMessage { Id = "m1", Content = "from a subagent", SubagentId = "s1" },
            new AGUIToolMessage { Id = "m2", Content = "done", ToolCallId = "tc1", SubagentId = "s2" },
            new AGUIUserMessage { Id = "m3", Content = new AGUIUserContent("hi"), SubagentId = "s3" },
            new AGUIAssistantMessage { Id = "m4", Content = "from the parent" },
        };

        var back = original.AsChatMessages().AsAGUIMessages().ToList();

        var byId = back.ToDictionary(m => m.Id!, m => m.SubagentId);
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
    public void EmptySubagentId_SurvivesTheRoundTrip()
    {
        // An empty string is a valid opaque id — the schemas accept it — so treating it as
        // absent silently converted it to parent attribution on the next turn.
        var back = new List<AGUIMessage>
        {
            new AGUIAssistantMessage { Id = "m1", Content = "hi", SubagentId = "" },
        }.AsChatMessages().AsAGUIMessages().ToList();

        Assert.Equal("", Assert.Single(back).SubagentId);
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
                SubagentId = "s1",
                ToolCalls = new List<AGUIToolCall>
                {
                    new() { Id = "tc1", Type = "function", Function = new AGUIToolCallFunction { Name = "search", Arguments = "{}" } },
                },
            },
            new AGUIAssistantMessage
            {
                Id = "m2",
                SubagentId = "s2",
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
            merged.AdditionalProperties?.TryGetValue("agui.subagentId", out string? v) == true ? v : null);
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
                || !message.AdditionalProperties.ContainsKey("agui.subagentId"));
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
