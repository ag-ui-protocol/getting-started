using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests.Compatibility;

public sealed class ActivityEventsCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("activity-events.json");

    [Fact]
    public void ActivitySnapshot_WithReplaceTrue_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<ActivitySnapshotEvent>(evt);
        Assert.Equal("msg_activity", typed.MessageId);
        Assert.Equal("PLAN", typed.ActivityType);
        Assert.Equal(1, typed.Content.GetProperty("tasks").GetArrayLength());
        Assert.Equal("search", typed.Content.GetProperty("tasks")[0].GetString());
        Assert.True(typed.Replace);
    }

    [Fact]
    public void ActivitySnapshot_WithReplaceFalse_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[1]);

        var typed = Assert.IsType<ActivitySnapshotEvent>(evt);
        Assert.Equal("msg_activity", typed.MessageId);
        Assert.Equal("PLAN", typed.ActivityType);
        Assert.Equal(0, typed.Content.GetProperty("tasks").GetArrayLength());
        Assert.False(typed.Replace);
    }

    [Fact]
    public void ActivityDelta_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[2]);

        var typed = Assert.IsType<ActivityDeltaEvent>(evt);
        Assert.Equal("msg_activity", typed.MessageId);
        Assert.Equal("PLAN", typed.ActivityType);
        Assert.Equal(1, typed.Patch.GetArrayLength());
        Assert.Equal("replace", typed.Patch[0].GetProperty("op").GetString());
        Assert.Equal("/tasks/0", typed.Patch[0].GetProperty("path").GetString());
        Assert.Equal("\u2713 search", typed.Patch[0].GetProperty("value").GetString());
    }

    [Fact]
    public void AllActivityEvents_RoundTrip_PreservesType()
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
