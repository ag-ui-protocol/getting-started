using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests.Compatibility;

public sealed class StateEventsCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("state-events.json");

    [Fact]
    public void StateSnapshot_Basic_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<StateSnapshotEvent>(evt);
        Assert.Equal(1234567890, typed.Timestamp);
        Assert.Equal(42, typed.Snapshot.GetProperty("counter").GetInt32());
        Assert.Equal(3, typed.Snapshot.GetProperty("items").GetArrayLength());
        Assert.Equal("apple", typed.Snapshot.GetProperty("items")[0].GetString());
        Assert.True(typed.Snapshot.GetProperty("config").GetProperty("enabled").GetBoolean());
        Assert.Equal(3, typed.Snapshot.GetProperty("config").GetProperty("maxRetries").GetInt32());
    }

    [Fact]
    public void StateSnapshot_Empty_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[1]);

        var typed = Assert.IsType<StateSnapshotEvent>(evt);
        Assert.Equal(JsonValueKind.Object, typed.Snapshot.ValueKind);
        Assert.Empty(typed.Snapshot.EnumerateObject().ToArray());
    }

    [Fact]
    public void StateSnapshot_SpecialValues_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[2]);

        var typed = Assert.IsType<StateSnapshotEvent>(evt);
        Assert.Equal(JsonValueKind.Null, typed.Snapshot.GetProperty("nullValue").ValueKind);
        Assert.Equal("", typed.Snapshot.GetProperty("emptyString").GetString());
        Assert.Equal(0, typed.Snapshot.GetProperty("zero").GetInt32());
        Assert.Equal(-123, typed.Snapshot.GetProperty("negativeNumber").GetInt32());
        Assert.Equal(3.14159, typed.Snapshot.GetProperty("floatNumber").GetDouble(), 5);
        Assert.Empty(typed.Snapshot.GetProperty("emptyArray").EnumerateArray().ToArray());
        Assert.Empty(typed.Snapshot.GetProperty("emptyObject").EnumerateObject().ToArray());
        Assert.True(typed.Snapshot.GetProperty("boolValues").GetProperty("true").GetBoolean());
        Assert.False(typed.Snapshot.GetProperty("boolValues").GetProperty("false").GetBoolean());
        Assert.Equal("2023-01-15T10:30:00.000Z", typed.Snapshot.GetProperty("dateString").GetString());
    }

    [Fact]
    public void StateDelta_Basic_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[3]);

        var typed = Assert.IsType<StateDeltaEvent>(evt);
        Assert.Equal(1234567890, typed.Timestamp);
        Assert.Equal(2, typed.Delta.GetArrayLength());
        Assert.Equal("add", typed.Delta[0].GetProperty("op").GetString());
        Assert.Equal("/counter", typed.Delta[0].GetProperty("path").GetString());
        Assert.Equal(42, typed.Delta[0].GetProperty("value").GetInt32());
    }

    [Fact]
    public void StateDelta_AllJsonPatchOperations_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[4]);

        var typed = Assert.IsType<StateDeltaEvent>(evt);
        Assert.Equal(6, typed.Delta.GetArrayLength());

        // add
        Assert.Equal("add", typed.Delta[0].GetProperty("op").GetString());
        Assert.Equal("/users/123", typed.Delta[0].GetProperty("path").GetString());
        Assert.Equal("John", typed.Delta[0].GetProperty("value").GetProperty("name").GetString());

        // remove
        Assert.Equal("remove", typed.Delta[1].GetProperty("op").GetString());
        Assert.Equal("/users/456", typed.Delta[1].GetProperty("path").GetString());

        // replace
        Assert.Equal("replace", typed.Delta[2].GetProperty("op").GetString());
        Assert.Equal("Jane Doe", typed.Delta[2].GetProperty("value").GetString());

        // move
        Assert.Equal("move", typed.Delta[3].GetProperty("op").GetString());
        Assert.Equal("/users/old", typed.Delta[3].GetProperty("from").GetString());
        Assert.Equal("/users/new", typed.Delta[3].GetProperty("path").GetString());

        // copy
        Assert.Equal("copy", typed.Delta[4].GetProperty("op").GetString());
        Assert.Equal("/templates/default", typed.Delta[4].GetProperty("from").GetString());

        // test
        Assert.Equal("test", typed.Delta[5].GetProperty("op").GetString());
        Assert.True(typed.Delta[5].GetProperty("value").GetBoolean());
    }

    [Fact]
    public void StateDelta_Empty_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[5]);

        var typed = Assert.IsType<StateDeltaEvent>(evt);
        Assert.Equal(0, typed.Delta.GetArrayLength());
    }

    [Fact]
    public void AllStateEvents_RoundTrip_PreservesType()
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
