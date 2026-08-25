using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ReasoningMessageContentEventTest
{
    [Fact]
    public void Serialize_IncludesTypeMessageIdAndDelta()
    {
        var evt = new ReasoningMessageContentEvent { MessageId = "msg-1", Delta = "thinking..." };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageContentEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_MESSAGE_CONTENT", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
        Assert.Equal("thinking...", root.GetProperty("delta").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ReasoningMessageContentEvent { MessageId = "msg-2", Delta = "step 1" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageContentEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ReasoningMessageContentEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-2", deserialized.MessageId);
        Assert.Equal("step 1", deserialized.Delta);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"REASONING_MESSAGE_CONTENT","messageId":"msg-3","delta":"analyze"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var content = Assert.IsType<ReasoningMessageContentEvent>(evt);
        Assert.Equal("msg-3", content.MessageId);
        Assert.Equal("analyze", content.Delta);
    }
}
