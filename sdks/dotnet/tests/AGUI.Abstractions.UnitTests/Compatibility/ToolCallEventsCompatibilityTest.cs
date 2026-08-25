using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests.Compatibility;

public sealed class ToolCallEventsCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("tool-call-events.json");

    [Fact]
    public void ToolCallStart_Basic_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<ToolCallStartEvent>(evt);
        Assert.Equal("tool-1", typed.ToolCallId);
        Assert.Equal("get_weather", typed.ToolCallName);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void ToolCallStart_WithParentMessage_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[1]);

        var typed = Assert.IsType<ToolCallStartEvent>(evt);
        Assert.Equal("tool-1", typed.ToolCallId);
        Assert.Equal("search_database", typed.ToolCallName);
        Assert.Equal("msg-123", typed.ParentMessageId);
    }

    [Fact]
    public void ToolCallArgs_Basic_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[2]);

        var typed = Assert.IsType<ToolCallArgsEvent>(evt);
        Assert.Equal("tool-1", typed.ToolCallId);
        Assert.Equal("{\"location\":\"San Francisco\"}", typed.Delta);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void ToolCallArgs_ComplexJson_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[3]);

        var typed = Assert.IsType<ToolCallArgsEvent>(evt);
        Assert.Equal("db-query-tool-123", typed.ToolCallId);
        Assert.Contains("SELECT * FROM users", typed.Delta);
        Assert.Contains("\"age\":{\"min\":18,\"max\":65}", typed.Delta);
    }

    [Fact]
    public void ToolCallArgs_PartialJson_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[4]);

        var typed = Assert.IsType<ToolCallArgsEvent>(evt);
        Assert.Equal("streaming-tool", typed.ToolCallId);
        Assert.Equal("{\"location\":\"San Fran", typed.Delta);
    }

    [Fact]
    public void ToolCallEnd_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[5]);

        var typed = Assert.IsType<ToolCallEndEvent>(evt);
        Assert.Equal("tool-1", typed.ToolCallId);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void ToolCallResult_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[6]);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Equal("tc-1", typed.ToolCallId);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal("{\"ok\":true}", typed.Content);
    }

    [Fact]
    public void AllToolCallEvents_RoundTrip_PreservesType()
    {
        foreach (var fixture in _fixtures)
        {
            var evt = FixtureLoader.DeserializeAsBaseEvent(fixture);
            var reserialized = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
            var reDeserialized = JsonSerializer.Deserialize<BaseEvent>(reserialized, AGUIJsonSerializerContext.Default.BaseEvent)!;

            Assert.Equal(evt.Type, reDeserialized.Type);
        }
    }
}
