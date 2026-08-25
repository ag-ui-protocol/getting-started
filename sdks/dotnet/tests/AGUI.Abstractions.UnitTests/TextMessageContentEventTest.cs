using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class TextMessageContentEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndMessageIdAndDelta()
    {
        var evt = new TextMessageContentEvent
        {
            MessageId = "msg-1",
            Delta = "Hello "
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageContentEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TEXT_MESSAGE_CONTENT", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
        Assert.Equal("Hello ", root.GetProperty("delta").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new TextMessageContentEvent
        {
            MessageId = "msg-1",
            Delta = "world"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageContentEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.TextMessageContentEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-1", deserialized.MessageId);
        Assert.Equal("world", deserialized.Delta);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"hi"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var textContent = Assert.IsType<TextMessageContentEvent>(evt);
        Assert.Equal("msg-1", textContent.MessageId);
        Assert.Equal("hi", textContent.Delta);
    }
}
