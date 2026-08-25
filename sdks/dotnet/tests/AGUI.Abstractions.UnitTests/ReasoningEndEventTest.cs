using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ReasoningEndEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndMessageId()
    {
        var evt = new ReasoningEndEvent { MessageId = "msg-1" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningEndEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_END", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ReasoningEndEvent { MessageId = "msg-2" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningEndEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ReasoningEndEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-2", deserialized.MessageId);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"REASONING_END","messageId":"msg-3"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var end = Assert.IsType<ReasoningEndEvent>(evt);
        Assert.Equal("msg-3", end.MessageId);
    }
}
