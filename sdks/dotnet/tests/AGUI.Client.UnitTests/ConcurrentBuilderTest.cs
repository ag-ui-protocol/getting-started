using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

public sealed class ConcurrentBuilderTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    [Fact]
    public void InterleavedToolCallArgs_TrackedIndependently()
    {
        var builder = new ToolCallBuilder();
        builder.SetIds("thread1", "run1");

        // Start two tool calls
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "weather" });
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c2", ToolCallName = "search" });

        // Interleave args
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "{\"lo" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c2", Delta = "{\"qu" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "c\":\"NYC\"}" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c2", Delta = "ery\":\"test\"}" });

        // End in different order than started
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c2" }, s_options);
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);

        var updates = builder.FlushAsToolCalls();
        Assert.Equal(2, updates.Count);

        // c2 was ended first, so it appears first in the buffer
        var fc2 = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);
        var fc1 = Assert.IsType<FunctionCallContent>(updates[1].Contents[0]);

        Assert.Equal("weather", fc1.Name);
        Assert.Equal("c1", fc1.CallId);
        Assert.NotNull(fc1.Arguments);
        Assert.Equal("NYC", fc1.Arguments["loc"]?.ToString());

        Assert.Equal("search", fc2.Name);
        Assert.Equal("c2", fc2.CallId);
        Assert.NotNull(fc2.Arguments);
        Assert.Equal("test", fc2.Arguments["query"]?.ToString());
    }

    [Fact]
    public void ManySimultaneousToolCalls_AllTracked()
    {
        var builder = new ToolCallBuilder();

        // Start 10 tool calls
        for (int i = 0; i < 10; i++)
        {
            builder.StartToolCall(new ToolCallStartEvent
            {
                ToolCallId = $"call-{i}",
                ToolCallName = $"tool_{i}"
            });
        }

        // Append args to all of them
        for (int i = 0; i < 10; i++)
        {
            builder.AppendArgs(new ToolCallArgsEvent
            {
                ToolCallId = $"call-{i}",
                Delta = $"{{\"index\":{i}}}"
            });
        }

        // End all in reverse order
        for (int i = 9; i >= 0; i--)
        {
            builder.EndToolCall(new ToolCallEndEvent { ToolCallId = $"call-{i}" }, s_options);
        }

        var allUpdates = builder.FlushAsToolCalls();
        Assert.Equal(10, allUpdates.Count);

        // Verify all tool calls are present (in reverse order since that's how they were ended)
        for (int i = 0; i < 10; i++)
        {
            var fc = Assert.IsType<FunctionCallContent>(allUpdates[i].Contents[0]);
            var expectedIndex = 9 - i;
            Assert.Equal($"tool_{expectedIndex}", fc.Name);
            Assert.Equal($"call-{expectedIndex}", fc.CallId);
        }
    }

    [Fact]
    public void ConcurrentToolCalls_OneEmptyOneComplex()
    {
        var builder = new ToolCallBuilder();

        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "no_args_tool" });
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c2", ToolCallName = "complex_tool" });

        // Only append args to c2
        builder.AppendArgs(new ToolCallArgsEvent
        {
            ToolCallId = "c2",
            Delta = "{\"nested\":{\"a\":1,\"b\":[1,2,3]},\"flag\":true}"
        });

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c2" }, s_options);

        var updates = builder.FlushAsToolCalls();
        Assert.Equal(2, updates.Count);

        var fc1 = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);
        Assert.Null(fc1.Arguments);

        var fc2 = Assert.IsType<FunctionCallContent>(updates[1].Contents[0]);
        Assert.NotNull(fc2.Arguments);
        Assert.True(fc2.Arguments.ContainsKey("nested"));
        Assert.True(fc2.Arguments.ContainsKey("flag"));
    }

    [Fact]
    public void SequentialTextMessages_BuilderResetsCorrectly()
    {
        var builder = new TextMessageBuilder();
        builder.SetConversationAndResponseIds("thread1", "run1");

        // First message lifecycle
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "m1", Role = "assistant" });
        var u1 = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "m1", Delta = "First" });
        builder.EndCurrentMessage(new TextMessageEndEvent { MessageId = "m1" });

        // Second message lifecycle
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "m2", Role = "user" });
        var u2 = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "m2", Delta = "Second" });
        builder.EndCurrentMessage(new TextMessageEndEvent { MessageId = "m2" });

        // Third message with different role
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "m3", Role = "system" });
        var u3 = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "m3", Delta = "Third" });
        builder.EndCurrentMessage(new TextMessageEndEvent { MessageId = "m3" });

        Assert.Equal(ChatRole.Assistant, u1.Role);
        Assert.Equal("First", u1.Text);
        Assert.Equal("m1", u1.MessageId);

        Assert.Equal(ChatRole.User, u2.Role);
        Assert.Equal("Second", u2.Text);
        Assert.Equal("m2", u2.MessageId);

        Assert.Equal(ChatRole.System, u3.Role);
        Assert.Equal("Third", u3.Text);
        Assert.Equal("m3", u3.MessageId);
    }

    [Fact]
    public void TextBuilder_MultipleContentDeltas_EmitsAll()
    {
        var builder = new TextMessageBuilder();
        builder.SetConversationAndResponseIds("thread1", "run1");
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "m1", Role = "assistant" });

        var updates = new List<ChatResponseUpdate>();
        for (int i = 0; i < 20; i++)
        {
            updates.Add(builder.EmitTextUpdate(new TextMessageContentEvent
            {
                MessageId = "m1",
                Delta = $"chunk{i} "
            }));
        }

        builder.EndCurrentMessage(new TextMessageEndEvent { MessageId = "m1" });

        Assert.Equal(20, updates.Count);
        for (int i = 0; i < 20; i++)
        {
            Assert.Equal($"chunk{i} ", updates[i].Text);
            Assert.Equal(ChatRole.Assistant, updates[i].Role);
        }
    }

    [Fact]
    public void ToolCallBuilder_StartSameIdTwice_Throws()
    {
        var builder = new ToolCallBuilder();

        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "first_tool" });

        // Starting again with same ID throws
        var ex = Assert.Throws<InvalidOperationException>(() =>
            builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "second_tool" }));
        Assert.Contains("c1", ex.Message);
        Assert.Contains("already in progress", ex.Message);
    }

    [Fact]
    public void TextBuilder_ConcurrentStart_SupportsDifferentIds()
    {
        var builder = new TextMessageBuilder();

        builder.AddTextStart(new TextMessageStartEvent { MessageId = "m1", Role = "assistant" });
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "m2", Role = "user" });

        var update1 = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" });
        var update2 = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "m2", Delta = "World" });

        Assert.Equal(ChatRole.Assistant, update1.Role);
        Assert.Equal(ChatRole.User, update2.Role);
    }

    [Fact]
    public void InterleavedTextAndToolCalls_IndependentBuilders()
    {
        var textBuilder = new TextMessageBuilder();
        var toolBuilder = new ToolCallBuilder();
        textBuilder.SetConversationAndResponseIds("thread1", "run1");
        toolBuilder.SetIds("thread1", "run1");

        // Simulate interleaved text + tool call events
        textBuilder.AddTextStart(new TextMessageStartEvent { MessageId = "m1", Role = "assistant" });
        toolBuilder.StartToolCall(new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" });

        var textUpdate1 = textBuilder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "m1", Delta = "Let me " });
        toolBuilder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"q\":" });

        var textUpdate2 = textBuilder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "m1", Delta = "search..." });
        toolBuilder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "\"test\"}" });

        textBuilder.EndCurrentMessage(new TextMessageEndEvent { MessageId = "m1" });
        toolBuilder.EndToolCall(new ToolCallEndEvent { ToolCallId = "tc1" }, s_options);
        var toolUpdates = toolBuilder.FlushAsToolCalls();

        Assert.Equal("Let me ", textUpdate1.Text);
        Assert.Equal("search...", textUpdate2.Text);
        Assert.Single(toolUpdates);
        var fc = Assert.IsType<FunctionCallContent>(toolUpdates[0].Contents[0]);
        Assert.Equal("search", fc.Name);
    }
}
