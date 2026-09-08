using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ReasoningStartEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndMessageId()
    {
        var evt = new ReasoningStartEvent { MessageId = "msg-1" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningStartEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_START", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ReasoningStartEvent { MessageId = "msg-2" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningStartEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ReasoningStartEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-2", deserialized.MessageId);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"REASONING_START","messageId":"msg-3"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var start = Assert.IsType<ReasoningStartEvent>(evt);
        Assert.Equal("msg-3", start.MessageId);
    }
}
