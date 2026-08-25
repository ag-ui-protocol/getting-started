using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class RawEventTest
{
    [Fact]
    public void Serialize_IncludesTypeEventAndSource()
    {
        var evt = new RawEvent
        {
            Event = JsonSerializer.SerializeToElement(new { action = "button_click", elementId = "submit-btn" }),
            Source = "frontend"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RawEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("RAW", root.GetProperty("type").GetString());
        Assert.Equal("frontend", root.GetProperty("source").GetString());
        Assert.Equal("button_click", root.GetProperty("event").GetProperty("action").GetString());
    }

    [Fact]
    public void Serialize_OmitsSourceWhenNull()
    {
        var evt = new RawEvent
        {
            Event = JsonSerializer.SerializeToElement(new { data = "test" })
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RawEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.False(root.TryGetProperty("source", out _));
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new RawEvent
        {
            Event = JsonSerializer.SerializeToElement(new { type = "user_action", timestamp = 1234567890 }),
            Source = "backend"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.RawEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.RawEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("backend", deserialized.Source);
        Assert.Equal("user_action", deserialized.Event.GetProperty("type").GetString());
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"RAW","event":{"data":"test"},"source":"external"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var raw = Assert.IsType<RawEvent>(evt);
        Assert.Equal("external", raw.Source);
        Assert.Equal("test", raw.Event.GetProperty("data").GetString());
    }
}
