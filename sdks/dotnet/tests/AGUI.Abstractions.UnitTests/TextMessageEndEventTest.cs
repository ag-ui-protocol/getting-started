using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class TextMessageEndEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndMessageId()
    {
        var evt = new TextMessageEndEvent
        {
            MessageId = "msg-1"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageEndEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TEXT_MESSAGE_END", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TEXT_MESSAGE_END","messageId":"msg-1"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var textEnd = Assert.IsType<TextMessageEndEvent>(evt);
        Assert.Equal("msg-1", textEnd.MessageId);
    }
}
