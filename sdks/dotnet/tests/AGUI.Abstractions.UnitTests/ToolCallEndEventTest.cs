using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ToolCallEndEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndToolCallId()
    {
        var evt = new ToolCallEndEvent
        {
            ToolCallId = "call-1"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallEndEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TOOL_CALL_END", root.GetProperty("type").GetString());
        Assert.Equal("call-1", root.GetProperty("toolCallId").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ToolCallEndEvent
        {
            ToolCallId = "call-2"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallEndEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ToolCallEndEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("call-2", deserialized.ToolCallId);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TOOL_CALL_END","toolCallId":"call-3"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallEndEvent>(evt);
        Assert.Equal("call-3", typed.ToolCallId);
    }
}
