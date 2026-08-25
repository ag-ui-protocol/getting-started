using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class CustomEventTest
{
    [Fact]
    public void Serialize_IncludesTypeNameAndValue()
    {
        var evt = new CustomEvent
        {
            Name = "user_preference_updated",
            Value = JsonSerializer.SerializeToElement(new { theme = "dark", fontSize = "medium" })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.CustomEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("CUSTOM", root.GetProperty("type").GetString());
        Assert.Equal("user_preference_updated", root.GetProperty("name").GetString());
        Assert.Equal("dark", root.GetProperty("value").GetProperty("theme").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new CustomEvent
        {
            Name = "analytics_event",
            Value = JsonSerializer.SerializeToElement(new { action = "click", count = 5 })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.CustomEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.CustomEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("analytics_event", deserialized.Name);
        Assert.Equal("click", deserialized.Value!.Value.GetProperty("action").GetString());
        Assert.Equal(5, deserialized.Value!.Value.GetProperty("count").GetInt32());
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"CUSTOM","name":"test_event","value":{"key":"val"}}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var custom = Assert.IsType<CustomEvent>(evt);
        Assert.Equal("test_event", custom.Name);
        Assert.Equal("val", custom.Value!.Value.GetProperty("key").GetString());
    }
}
