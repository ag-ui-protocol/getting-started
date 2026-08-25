using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ReasoningMessageEndEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndMessageId()
    {
        var evt = new ReasoningMessageEndEvent { MessageId = "msg-1" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageEndEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_MESSAGE_END", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ReasoningMessageEndEvent { MessageId = "msg-2" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageEndEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ReasoningMessageEndEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-2", deserialized.MessageId);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"REASONING_MESSAGE_END","messageId":"msg-3"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var end = Assert.IsType<ReasoningMessageEndEvent>(evt);
        Assert.Equal("msg-3", end.MessageId);
    }
}
