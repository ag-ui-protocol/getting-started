using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

public sealed class ToolCallBuilderTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;
    [Fact]
    public void EndToolCall_ReturnsFunctionCallContent()
    {
        var builder = new ToolCallBuilder();
        builder.SetIds("thread1", "run1");

        builder.StartToolCall(new ToolCallStartEvent
        {
            ToolCallId = "call1",
            ToolCallName = "get_weather"
        });

        builder.AppendArgs(new ToolCallArgsEvent
        {
            ToolCallId = "call1",
            Delta = "{\"location\":\"NYC\"}"
        });

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "call1" }, s_options);
        var updates = builder.FlushAsToolCalls();

        Assert.Single(updates);
        var update = updates[0];
        Assert.Single(update.Contents);
        var funcCall = Assert.IsType<FunctionCallContent>(update.Contents[0]);
        Assert.Equal("get_weather", funcCall.Name);
        Assert.Equal("call1", funcCall.CallId);
        Assert.Equal("thread1", update.ConversationId);
        Assert.Equal("run1", update.ResponseId);
    }

    [Fact]
    public void AppendArgs_AccumulatesMultipleDeltas()
    {
        var builder = new ToolCallBuilder();
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "test" });

        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "{\"a\":" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "1}" });

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        var updates = builder.FlushAsToolCalls();
        Assert.Single(updates);
        var funcCall = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);

        Assert.NotNull(funcCall.Arguments);
        Assert.True(funcCall.Arguments.ContainsKey("a"));
    }

    [Fact]
    public void EndToolCall_ThrowsForUnknownToolCallId()
    {
        var builder = new ToolCallBuilder();

        var ex = Assert.Throws<InvalidOperationException>(() =>
            builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "unknown" }, s_options));
        Assert.Contains("unknown", ex.Message);
    }

    [Fact]
    public void AppendArgs_ThrowsForUnknownToolCallId()
    {
        var builder = new ToolCallBuilder();

        var ex = Assert.Throws<InvalidOperationException>(() =>
            builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "unknown", Delta = "test" }));
        Assert.Contains("unknown", ex.Message);
    }

    [Fact]
    public void EndToolCall_WithEmptyArgs_ReturnsNullArguments()
    {
        var builder = new ToolCallBuilder();
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "no_args" });

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        var updates = builder.FlushAsToolCalls();

        Assert.Single(updates);
        var funcCall = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);
        Assert.Null(funcCall.Arguments);
    }

    [Fact]
    public void MultipleToolCalls_TrackedIndependently()
    {
        var builder = new ToolCallBuilder();
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "tool_a" });
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c2", ToolCallName = "tool_b" });

        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "{\"x\":1}" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c2", Delta = "{\"y\":2}" });

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c2" }, s_options);

        var updates = builder.FlushAsToolCalls();
        Assert.Equal(2, updates.Count);

        var fc1 = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);
        var fc2 = Assert.IsType<FunctionCallContent>(updates[1].Contents[0]);

        Assert.Equal("tool_a", fc1.Name);
        Assert.Equal("tool_b", fc2.Name);
    }

    [Fact]
    public void InvalidJsonArgs_ThrowsJsonException()
    {
        var builder = new ToolCallBuilder();
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "test" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "not valid json" });

        Assert.Throws<System.Text.Json.JsonException>(() =>
            builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options));
    }

    [Fact]
    public void SequentialToolCalls_CanReuseBuilder()
    {
        var builder = new ToolCallBuilder();
        builder.SetIds("thread1", "run1");

        // First tool call
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "tool1" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "{\"k\":\"v1\"}" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);

        // Second tool call on same builder
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c2", ToolCallName = "tool2" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c2", Delta = "{\"k\":\"v2\"}" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c2" }, s_options);

        var updates = builder.FlushAsToolCalls();
        Assert.Equal(2, updates.Count);

        var fc1 = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);
        var fc2 = Assert.IsType<FunctionCallContent>(updates[1].Contents[0]);

        Assert.Equal("tool1", fc1.Name);
        Assert.Equal("c1", fc1.CallId);
        Assert.Equal("tool2", fc2.Name);
        Assert.Equal("c2", fc2.CallId);
    }

    [Fact]
    public void Args_WithNestedJsonObjects_ParsesCorrectly()
    {
        var builder = new ToolCallBuilder();
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "test" });
        builder.AppendArgs(new ToolCallArgsEvent
        {
            ToolCallId = "c1",
            Delta = "{\"name\":\"test\",\"count\":42,\"active\":true,\"tags\":null}"
        });

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        var updates = builder.FlushAsToolCalls();

        Assert.Single(updates);
        var funcCall = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);
        Assert.NotNull(funcCall.Arguments);
        Assert.Equal("test", funcCall.Arguments["name"]?.ToString());
        Assert.Equal("42", funcCall.Arguments["count"]?.ToString());
        Assert.Equal("True", funcCall.Arguments["active"]?.ToString());
        Assert.Null(funcCall.Arguments["tags"]);
    }

    [Fact]
    public void Args_WithJsonArray_ReturnsJsonElement()
    {
        var builder = new ToolCallBuilder();
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "test" });
        // Array value should be returned as JsonElement (not a primitive)
        builder.AppendArgs(new ToolCallArgsEvent
        {
            ToolCallId = "c1",
            Delta = "{\"items\":[1,2,3]}"
        });

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        var updates = builder.FlushAsToolCalls();

        Assert.Single(updates);
        var funcCall = Assert.IsType<FunctionCallContent>(updates[0].Contents[0]);
        Assert.NotNull(funcCall.Arguments);
        Assert.True(funcCall.Arguments.ContainsKey("items"));
        // Array values are returned as JsonElement since we can't represent them as primitives
        Assert.IsType<System.Text.Json.JsonElement>(funcCall.Arguments["items"]);
    }

    [Fact]
    public void Args_AsJsonArrayRoot_ReturnsNullArguments()
    {
        var builder = new ToolCallBuilder();
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "test" });
        // Root-level array is not a valid tool call arguments shape
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "[1,2,3]" });

        Assert.ThrowsAny<System.Exception>(() =>
            builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options));
    }

    [Fact]
    public void IsBuffering_TrueAfterEndToolCall_FalseAfterFlush()
    {
        var builder = new ToolCallBuilder();
        Assert.False(builder.IsBuffering);

        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "tool" });
        Assert.False(builder.IsBuffering);

        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        Assert.True(builder.IsBuffering);

        builder.FlushAsToolCalls();
        Assert.False(builder.IsBuffering);
    }

    [Fact]
    public void AddResult_SingleToolCall_FlushesImmediately()
    {
        var builder = new ToolCallBuilder();
        builder.SetIds("thread1", "run1");

        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "get_weather" });
        builder.AppendArgs(new ToolCallArgsEvent { ToolCallId = "c1", Delta = "{\"loc\":\"NYC\"}" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);

        var resultUpdate = new ChatResponseUpdate(ChatRole.Tool,
            [new FunctionResultContent("c1", "sunny")]);

        var flushed = builder.AddResult("c1", resultUpdate);

        Assert.Equal(2, flushed.Count);
        var fcc = Assert.IsType<FunctionCallContent>(flushed[0].Contents[0]);
        Assert.Equal("get_weather", fcc.Name);
        Assert.Equal("c1", fcc.CallId);
        var frc = Assert.IsType<FunctionResultContent>(flushed[1].Contents[0]);
        Assert.Equal("c1", frc.CallId);
        Assert.False(builder.IsBuffering);
    }

    [Fact]
    public void AddResult_MultipleToolCalls_FlushesWhenAllResolved()
    {
        var builder = new ToolCallBuilder();
        builder.SetIds("thread1", "run1");

        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "tool_a" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c2", ToolCallName = "tool_b" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c2" }, s_options);

        var result1 = new ChatResponseUpdate(ChatRole.Tool,
            [new FunctionResultContent("c1", "result_a")]);

        // First result — c2 still pending, should not flush
        var flushed1 = builder.AddResult("c1", result1);
        Assert.Empty(flushed1);
        Assert.True(builder.IsBuffering);

        var result2 = new ChatResponseUpdate(ChatRole.Tool,
            [new FunctionResultContent("c2", "result_b")]);

        // Second result — all resolved, should flush everything in order
        var flushed2 = builder.AddResult("c2", result2);
        Assert.Equal(4, flushed2.Count);

        // FCC(c1), FCC(c2), FRC(c1), FRC(c2)
        Assert.IsType<FunctionCallContent>(flushed2[0].Contents[0]);
        Assert.IsType<FunctionCallContent>(flushed2[1].Contents[0]);
        Assert.IsType<FunctionResultContent>(flushed2[2].Contents[0]);
        Assert.IsType<FunctionResultContent>(flushed2[3].Contents[0]);
        Assert.False(builder.IsBuffering);
    }

    [Fact]
    public void BufferUpdate_PreservesOrderWithToolCalls()
    {
        var builder = new ToolCallBuilder();
        builder.SetIds("thread1", "run1");

        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "tool" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);

        // Buffer a text update while tool call is pending
        var textUpdate = new ChatResponseUpdate(ChatRole.Assistant, [new TextContent("thinking...")]);
        builder.BufferUpdate(textUpdate);

        var resultUpdate = new ChatResponseUpdate(ChatRole.Tool,
            [new FunctionResultContent("c1", "done")]);

        var flushed = builder.AddResult("c1", resultUpdate);

        // Order: FCC, text, FRC
        Assert.Equal(3, flushed.Count);
        Assert.IsType<FunctionCallContent>(flushed[0].Contents[0]);
        Assert.Equal("thinking...", flushed[1].Text);
        Assert.IsType<FunctionResultContent>(flushed[2].Contents[0]);
    }

    [Fact]
    public void AddResult_SequentialBatches_FlushIndependently()
    {
        var builder = new ToolCallBuilder();
        builder.SetIds("thread1", "run1");

        // First batch
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "tool_a" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c1" }, s_options);

        var result1 = new ChatResponseUpdate(ChatRole.Tool,
            [new FunctionResultContent("c1", "result_a")]);
        var flushed1 = builder.AddResult("c1", result1);
        Assert.Equal(2, flushed1.Count);
        Assert.False(builder.IsBuffering);

        // Second batch — independent
        builder.StartToolCall(new ToolCallStartEvent { ToolCallId = "c2", ToolCallName = "tool_b" });
        builder.EndToolCall(new ToolCallEndEvent { ToolCallId = "c2" }, s_options);
        Assert.True(builder.IsBuffering);

        var result2 = new ChatResponseUpdate(ChatRole.Tool,
            [new FunctionResultContent("c2", "result_b")]);
        var flushed2 = builder.AddResult("c2", result2);
        Assert.Equal(2, flushed2.Count);
        Assert.False(builder.IsBuffering);
    }
}
