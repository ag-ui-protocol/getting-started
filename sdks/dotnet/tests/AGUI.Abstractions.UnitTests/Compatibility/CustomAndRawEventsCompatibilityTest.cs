using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests.Compatibility;

public sealed class CustomAndRawEventsCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("custom-and-raw-events.json");

    [Fact]
    public void CustomEvent_WithValue_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<CustomEvent>(evt);
        Assert.Equal("user_preference_updated", typed.Name);
        Assert.Equal(1234567890, typed.Timestamp);
        Assert.Equal("dark", typed.Value!.Value.GetProperty("theme").GetString());
        Assert.Equal("medium", typed.Value!.Value.GetProperty("fontSize").GetString());
        Assert.True(typed.Value!.Value.GetProperty("notifications").GetBoolean());
    }

    [Fact]
    public void CustomEvent_WithoutValue_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[1]);

        var typed = Assert.IsType<CustomEvent>(evt);
        Assert.Equal("heartbeat", typed.Name);
        Assert.Null(typed.Value);
    }

    [Fact]
    public void RawEvent_Basic_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[2]);

        var typed = Assert.IsType<RawEvent>(evt);
        Assert.Equal("frontend", typed.Source);
        Assert.Equal(1234567890, typed.Timestamp);
        Assert.Equal("user_action", typed.Event.GetProperty("type").GetString());
        Assert.Equal("button_click", typed.Event.GetProperty("action").GetString());
        Assert.Equal("submit-btn", typed.Event.GetProperty("elementId").GetString());
    }

    [Fact]
    public void RawEvent_ComplexNested_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[3]);

        var typed = Assert.IsType<RawEvent>(evt);
        Assert.Null(typed.Source);
        Assert.Equal("analytics_event", typed.Event.GetProperty("type").GetString());

        var session = typed.Event.GetProperty("session");
        Assert.Equal("sess-12345", session.GetProperty("id").GetString());
        Assert.Equal("user-456", session.GetProperty("user").GetProperty("id").GetString());
        Assert.Equal("premium", session.GetProperty("user").GetProperty("attributes").GetProperty("plan").GetString());

        var actions = session.GetProperty("actions");
        Assert.Equal(2, actions.GetArrayLength());
        Assert.Equal("page_view", actions[0].GetProperty("type").GetString());
        Assert.Equal("button_click", actions[1].GetProperty("type").GetString());

        var metadata = typed.Event.GetProperty("metadata");
        Assert.Equal("web", metadata.GetProperty("source").GetString());
        Assert.Equal("1.2.3", metadata.GetProperty("version").GetString());
        Assert.Equal("production", metadata.GetProperty("environment").GetString());
    }

    [Fact]
    public void AllCustomAndRawEvents_RoundTrip_PreservesType()
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
