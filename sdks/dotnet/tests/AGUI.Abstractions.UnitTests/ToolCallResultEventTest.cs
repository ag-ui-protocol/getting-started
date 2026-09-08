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
}
