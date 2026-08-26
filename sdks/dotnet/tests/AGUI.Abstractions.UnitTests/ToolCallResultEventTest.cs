using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ToolCallResultEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndToolCallIdAndContent()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "{\"temp\":72}"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TOOL_CALL_RESULT", root.GetProperty("type").GetString());
        Assert.Equal("call-1", root.GetProperty("toolCallId").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
        Assert.Equal("{\"temp\":72}", root.GetProperty("content").GetString());
    }

    [Fact]
    public void Serialize_IncludesRole_WhenSet()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "result-data",
            Role = "tool"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("tool", doc.RootElement.GetProperty("role").GetString());
    }

    [Fact]
    public void Serialize_OmitsRole_WhenNull()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "ok"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.False(doc.RootElement.TryGetProperty("role", out _));
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-2",
            MessageId = "msg-2",
            Content = "success",
            Role = "tool"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ToolCallResultEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("call-2", deserialized.ToolCallId);
        Assert.Equal("msg-2", deserialized.MessageId);
        Assert.Equal("success", deserialized.Content);
        Assert.Equal("tool", deserialized.Role);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TOOL_CALL_RESULT","toolCallId":"call-3","messageId":"msg-3","content":"done"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Equal("call-3", typed.ToolCallId);
        Assert.Equal("msg-3", typed.MessageId);
        Assert.Equal("done", typed.Content);
    }

    // `Error` is the event-side twin of AGUIToolMessage.Error: set when the tool call
    // failed, so a consumer can render the failure from the live stream rather than
    // waiting for the messages snapshot that carries the finished message.

    [Fact]
    public void Serialize_IncludesError_WhenSet()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = string.Empty,
            Error = "SearchTimeout: upstream did not respond within 30s"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal(
            "SearchTimeout: upstream did not respond within 30s",
            doc.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public void Serialize_OmitsError_WhenNull()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "ok"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.False(doc.RootElement.TryGetProperty("error", out _));
    }

    [Fact]
    public void Serialize_KeepsEmptyStringError()
    {
        // WhenWritingNull omits null, not empty — an empty string is a value the
        // producer chose to send, and dropping it would read as "the call succeeded".
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-1",
            MessageId = "msg-1",
            Content = "ok",
            Error = string.Empty
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.True(doc.RootElement.TryGetProperty("error", out var error));
        Assert.Equal(string.Empty, error.GetString());
    }

    [Fact]
    public void Deserialize_RoundTripsError()
    {
        var evt = new ToolCallResultEvent
        {
            ToolCallId = "call-2",
            MessageId = "msg-2",
            Content = string.Empty,
            Role = "tool",
            Error = "boom"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallResultEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ToolCallResultEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("boom", deserialized.Error);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_CarriesError()
    {
        var json = """{"type":"TOOL_CALL_RESULT","toolCallId":"call-3","messageId":"msg-3","content":"","error":"boom"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Equal("boom", typed.Error);
    }

    [Fact]
    public void Deserialize_ExistingEventWithoutError_LeavesItNull()
    {
        // The additive guarantee: an event from before this field existed is
        // unchanged, and reads back with no error.
        var json = """{"type":"TOOL_CALL_RESULT","toolCallId":"call-4","messageId":"msg-4","content":"done","role":"tool"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Null(typed.Error);
    }
}
