using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class ReasoningMessageStartEventTest
{
    [Fact]
    public void Serialize_IncludesTypeMessageIdAndRole()
    {
        var evt = new ReasoningMessageStartEvent { MessageId = "msg-1" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageStartEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("REASONING_MESSAGE_START", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
        Assert.Equal("reasoning", root.GetProperty("role").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new ReasoningMessageStartEvent { MessageId = "msg-2", Role = "reasoning" };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.ReasoningMessageStartEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.ReasoningMessageStartEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-2", deserialized.MessageId);
        Assert.Equal("reasoning", deserialized.Role);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"REASONING_MESSAGE_START","messageId":"msg-3","role":"reasoning"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var start = Assert.IsType<ReasoningMessageStartEvent>(evt);
        Assert.Equal("msg-3", start.MessageId);
        Assert.Equal("reasoning", start.Role);
    }

    [Fact]
    public void Role_DefaultsToReasoning()
    {
        var evt = new ReasoningMessageStartEvent { MessageId = "msg-4" };
        Assert.Equal("reasoning", evt.Role);
    }
}
