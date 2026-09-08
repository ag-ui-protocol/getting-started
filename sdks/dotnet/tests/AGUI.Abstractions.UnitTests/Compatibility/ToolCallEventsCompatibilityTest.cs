using System.Text.Json;
using System.Text.Json.Nodes;
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
        // A payload produced before `error` existed leaves it absent, not empty.
        Assert.Null(typed.Error);
    }

    [Fact]
    public void ToolCallResult_WithError_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[7]);

        var typed = Assert.IsType<ToolCallResultEvent>(evt);
        Assert.Equal("tc-2", typed.ToolCallId);
        Assert.Equal("msg-2", typed.MessageId);
        Assert.Equal("SearchTimeout: upstream did not respond within 30s", typed.Error);

        // `Content` is initialised to string.Empty, so `Assert.Equal(string.Empty, ...)` on
        // its own passes whether or not the property ever read the wire — renaming its JSON
        // property left this test green. Two assertions make the empty string mean "the
        // producer sent one": the payload really does carry an explicit empty `content`, and
        // the same payload with a sentinel in that slot reads the sentinel back.
        Assert.True(_fixtures[7].TryGetProperty("content", out var wireContent));
        Assert.Equal(string.Empty, wireContent.GetString());

        var withSentinel = JsonNode.Parse(_fixtures[7].GetRawText())!.AsObject();
        withSentinel["content"] = "not-empty";
        var control = JsonSerializer.Deserialize(
            withSentinel.ToJsonString(),
            AGUIJsonSerializerContext.Default.BaseEvent);
        Assert.Equal("not-empty", Assert.IsType<ToolCallResultEvent>(control).Content);

        Assert.Equal(string.Empty, typed.Content);
    }

    [Fact]
    public void AllToolCallEvents_RoundTrip_PreserveEveryPropertyOnTheWire()
    {
        // `Type` alone is a compile-time constant on each event class, so a loop that
        // asserted only that could not fail on a lost field: renaming `error`'s JSON
        // property, which drops it from every payload, left this loop green. Every property
        // the fixture carries therefore has to come back with the same value.
        foreach (var fixture in _fixtures)
        {
            var evt = FixtureLoader.DeserializeAsBaseEvent(fixture);
            var reserialized = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
            var reDeserialized = JsonSerializer.Deserialize<BaseEvent>(reserialized, AGUIJsonSerializerContext.Default.BaseEvent)!;

            Assert.Equal(evt.Type, reDeserialized.Type);

            var produced = JsonNode.Parse(reserialized)!.AsObject();
            foreach (var property in fixture.EnumerateObject())
            {
                Assert.True(
                    produced.TryGetPropertyValue(property.Name, out var written),
                    $"round-tripping {fixture.GetRawText()} dropped '{property.Name}'");
                Assert.True(
                    JsonNode.DeepEquals(written, JsonNode.Parse(property.Value.GetRawText())),
                    $"round-tripping {fixture.GetRawText()} changed '{property.Name}' to {written?.ToJsonString() ?? "null"}");
            }
        }
    }
}
