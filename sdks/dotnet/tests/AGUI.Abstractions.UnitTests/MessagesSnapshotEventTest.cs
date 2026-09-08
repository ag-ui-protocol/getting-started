using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class MessagesSnapshotEventTest
{
    // https://github.com/microsoft/agent-framework/issues/2510
    [Fact]
    public void MessagesSnapshotEvent_SerializesAndDeserializesViaBaseEvent()
    {
        var evt = new MessagesSnapshotEvent
        {
            Messages =
            [
                new AGUIUserMessage
                {
                    Id = "msg-1",
                    Content = [new AGUITextInputContent { Text = "Hello" }]
                }
            ]
        };

        var json = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.MessagesSnapshotEvent);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("MESSAGES_SNAPSHOT", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("msg-1", doc.RootElement.GetProperty("messages")[0].GetProperty("id").GetString());
        Assert.Equal("user", doc.RootElement.GetProperty("messages")[0].GetProperty("role").GetString());

        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);
        var snapshot = Assert.IsType<MessagesSnapshotEvent>(deserialized);
        var message = Assert.IsType<AGUIUserMessage>(Assert.Single(snapshot.Messages));
        var text = Assert.IsType<AGUITextInputContent>(Assert.Single(message.Content));
        Assert.Equal("Hello", text.Text);
    }

    // https://github.com/microsoft/agent-framework/issues/2558
    [Fact]
    public void MessagesSnapshotEvent_DeserializesViaBaseEvent()
    {
        var json = """
            {
              "type": "MESSAGES_SNAPSHOT",
              "messages": [
                { "id": "msg-1", "role": "user", "content": "hello" }
              ]
            }
            """;

        var evt = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

        var snapshot = Assert.IsType<MessagesSnapshotEvent>(evt);
        var message = Assert.IsType<AGUIUserMessage>(Assert.Single(snapshot.Messages));
        Assert.Equal("msg-1", message.Id);
        Assert.Equal("hello", Assert.IsType<AGUITextInputContent>(Assert.Single(message.Content)).Text);
    }
}
