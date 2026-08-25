using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ToolCallArgsEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndToolCallIdAndDelta()
    {
        var evt = new ToolCallArgsEvent
        {
            ToolCallId = "call-1",
            Delta = "{\"location\":"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallArgsEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TOOL_CALL_ARGS", root.GetProperty("type").GetString());
        Assert.Equal("call-1", root.GetProperty("toolCallId").GetString());
        Assert.Equal("{\"location\":", root.GetProperty("delta").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ToolCallArgsEvent
        {
            ToolCallId = "call-2",
            Delta = "\"Seattle\"}"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ToolCallArgsEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ToolCallArgsEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("call-2", deserialized.ToolCallId);
        Assert.Equal("\"Seattle\"}", deserialized.Delta);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TOOL_CALL_ARGS","toolCallId":"call-3","delta":"test"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var typed = Assert.IsType<ToolCallArgsEvent>(evt);
        Assert.Equal("call-3", typed.ToolCallId);
        Assert.Equal("test", typed.Delta);
    }
}
