using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ReasoningMessageChunkEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndOptionalFields()
    {
        var evt = new ReasoningMessageChunkEvent { MessageId = "msg-1", Delta = "chunk" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageChunkEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_MESSAGE_CHUNK", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
        Assert.Equal("chunk", root.GetProperty("delta").GetString());
    }

    [Fact]
    public void Serialize_OmitsNullOptionalFields()
    {
        var evt = new ReasoningMessageChunkEvent();

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageChunkEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_MESSAGE_CHUNK", root.GetProperty("type").GetString());
        Assert.False(root.TryGetProperty("messageId", out _));
        Assert.False(root.TryGetProperty("delta", out _));
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ReasoningMessageChunkEvent { MessageId = "msg-2", Delta = "data" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageChunkEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ReasoningMessageChunkEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-2", deserialized.MessageId);
        Assert.Equal("data", deserialized.Delta);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"REASONING_MESSAGE_CHUNK","messageId":"msg-3","delta":"text"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var chunk = Assert.IsType<ReasoningMessageChunkEvent>(evt);
        Assert.Equal("msg-3", chunk.MessageId);
        Assert.Equal("text", chunk.Delta);
    }
}
