using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ToolCallStartEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndToolCallIdAndName()
    {
        var evt = new ToolCallStartEvent
        {
            ToolCallId = "call-1",
            ToolCallName = "get_weather"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallStartEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TOOL_CALL_START", root.GetProperty("type").GetString());
        Assert.Equal("call-1", root.GetProperty("toolCallId").GetString());
        Assert.Equal("get_weather", root.GetProperty("toolCallName").GetString());
    }

    [Fact]
    public void Serialize_IncludesParentMessageId_WhenSet()
    {
        var evt = new ToolCallStartEvent
        {
            ToolCallId = "call-1",
            ToolCallName = "get_weather",
            ParentMessageId = "msg-1"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallStartEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("msg-1", doc.RootElement.GetProperty("parentMessageId").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ToolCallStartEvent
        {
            ToolCallId = "call-2",
            ToolCallName = "search"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallStartEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ToolCallStartEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("call-2", deserialized.ToolCallId);
        Assert.Equal("search", deserialized.ToolCallName);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TOOL_CALL_START","toolCallId":"call-3","toolCallName":"get_weather"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallStartEvent>(evt);
        Assert.Equal("call-3", typed.ToolCallId);
        Assert.Equal("get_weather", typed.ToolCallName);
    }

    // https://github.com/microsoft/agent-framework/issues/2637
    [Fact]
    public void ToolCallStartEvent_Serialization_OmitsParentMessageId_WhenNull()
    {
        var evt = new ToolCallStartEvent
        {
            ToolCallId = "call-123",
            ToolCallName = "get_weather"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallStartEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.False(doc.RootElement.TryGetProperty("parentMessageId", out _));
    }
}
