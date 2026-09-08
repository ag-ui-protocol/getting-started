using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class StateSnapshotEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndSnapshot()
    {
        var evt = new StateSnapshotEvent
        {
            Snapshot = JsonSerializer.SerializeToElement(new { counter = 0, name = "test" })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StateSnapshotEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("STATE_SNAPSHOT", root.GetProperty("type").GetString());
        Assert.Equal(0, root.GetProperty("snapshot").GetProperty("counter").GetInt32());
        Assert.Equal("test", root.GetProperty("snapshot").GetProperty("name").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new StateSnapshotEvent
        {
            Snapshot = JsonSerializer.SerializeToElement(new { counter = 42 })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StateSnapshotEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.StateSnapshotEvent);

        Assert.NotNull(deserialized);
        Assert.Equal(42, deserialized.Snapshot.GetProperty("counter").GetInt32());
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"STATE_SNAPSHOT","snapshot":{"counter":10}}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var snapshot = Assert.IsType<StateSnapshotEvent>(evt);
        Assert.Equal(10, snapshot.Snapshot.GetProperty("counter").GetInt32());
    }
}
