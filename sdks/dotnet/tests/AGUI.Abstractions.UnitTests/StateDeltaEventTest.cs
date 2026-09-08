using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class StateDeltaEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndDelta()
    {
        var evt = new StateDeltaEvent
        {
            Delta = JsonSerializer.SerializeToElement(new[]
            {
                new { op = "replace", path = "/counter", value = 1 }
            })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StateDeltaEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("STATE_DELTA", root.GetProperty("type").GetString());
        var delta = root.GetProperty("delta");
        Assert.Equal(1, delta.GetArrayLength());
        Assert.Equal("replace", delta[0].GetProperty("op").GetString());
        Assert.Equal("/counter", delta[0].GetProperty("path").GetString());
        Assert.Equal(1, delta[0].GetProperty("value").GetInt32());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new StateDeltaEvent
        {
            Delta = JsonSerializer.SerializeToElement(new object[]
            {
                new { op = "add", path = "/items/-", value = "item1" },
                new { op = "remove", path = "/temp" }
            })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StateDeltaEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.StateDeltaEvent);

        Assert.NotNull(deserialized);
        Assert.Equal(2, deserialized.Delta.GetArrayLength());
        Assert.Equal("add", deserialized.Delta[0].GetProperty("op").GetString());
        Assert.Equal("/items/-", deserialized.Delta[0].GetProperty("path").GetString());
        Assert.Equal("remove", deserialized.Delta[1].GetProperty("op").GetString());
        Assert.Equal("/temp", deserialized.Delta[1].GetProperty("path").GetString());
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/counter","value":5}]}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var delta = Assert.IsType<StateDeltaEvent>(evt);
        Assert.Equal(1, delta.Delta.GetArrayLength());
        Assert.Equal("replace", delta.Delta[0].GetProperty("op").GetString());
        Assert.Equal("/counter", delta.Delta[0].GetProperty("path").GetString());
    }

    [Fact]
    public void Serialize_MoveOperation_IncludesFrom()
    {
        var evt = new StateDeltaEvent
        {
            Delta = JsonSerializer.SerializeToElement(new[]
            {
                new { op = "move", path = "/b", from = "/a" }
            })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.StateDeltaEvent);
        using var doc = JsonDocument.Parse(json);
        var op = doc.RootElement.GetProperty("delta")[0];

        Assert.Equal("move", op.GetProperty("op").GetString());
        Assert.Equal("/b", op.GetProperty("path").GetString());
        Assert.Equal("/a", op.GetProperty("from").GetString());
    }
}
