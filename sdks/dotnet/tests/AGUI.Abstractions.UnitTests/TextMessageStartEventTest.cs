using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class TextMessageStartEventTest
{
    [Fact]
    public void Serialize_IncludesTypeAndMessageIdAndRole()
    {
        var evt = new TextMessageStartEvent
        {
            MessageId = "msg-1",
            Role = "assistant"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageStartEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TEXT_MESSAGE_START", root.GetProperty("type").GetString());
        Assert.Equal("msg-1", root.GetProperty("messageId").GetString());
        Assert.Equal("assistant", root.GetProperty("role").GetString());
    }

    [Fact]
    public void Deserialize_RoundTrips()
    {
        var evt = new TextMessageStartEvent
        {
            MessageId = "msg-2",
            Role = "user"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageStartEvent);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        Assert.NotNull(deserialized);
        Assert.Equal("msg-2", deserialized.MessageId);
        Assert.Equal("user", deserialized.Role);
    }

    [Fact]
    public void Deserialize_ViaBaseEvent_ReturnsCorrectType()
    {
        var json = """{"type":"TEXT_MESSAGE_START","messageId":"msg-3","role":"assistant"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var textStart = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("msg-3", textStart.MessageId);
        Assert.Equal("assistant", textStart.Role);
    }

    [Fact]
    public void Serialize_WithName_IncludesName()
    {
        var evt = new TextMessageStartEvent
        {
            MessageId = "msg-4",
            Role = "assistant",
            Name = "TestAgent"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageStartEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("TestAgent", root.GetProperty("name").GetString());
    }

    [Fact]
    public void Serialize_WithoutName_OmitsName()
    {
        var evt = new TextMessageStartEvent
        {
            MessageId = "msg-5",
            Role = "assistant"
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.TextMessageStartEvent);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.False(root.TryGetProperty("name", out _));
    }

    [Fact]
    public void Deserialize_WithName_RoundTrips()
    {
        var json = """{"type":"TEXT_MESSAGE_START","messageId":"msg-6","role":"assistant","name":"MyAgent"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        Assert.NotNull(evt);
        Assert.Equal("msg-6", evt.MessageId);
        Assert.Equal("MyAgent", evt.Name);
    }

    [Fact]
    public void Deserialize_WithoutName_NameIsNull()
    {
        var json = """{"type":"TEXT_MESSAGE_START","messageId":"msg-7","role":"assistant"}""";
        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.TextMessageStartEvent);

        Assert.NotNull(evt);
        Assert.Null(evt.Name);
    }
}
