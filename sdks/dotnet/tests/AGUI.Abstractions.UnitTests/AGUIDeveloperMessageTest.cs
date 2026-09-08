using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class AGUIDeveloperMessageTest
{
    [Fact]
    public void Serializes_RoleAndContent()
    {
        AGUIMessage message = new AGUIDeveloperMessage { Id = "d1", Content = "be helpful" };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("developer", doc.RootElement.GetProperty("role").GetString());
        Assert.Equal("d1", doc.RootElement.GetProperty("id").GetString());
        Assert.Equal("be helpful", doc.RootElement.GetProperty("content").GetString());
    }

    [Fact]
    public void Deserializes_AsDeveloperMessage_NotSystemMessage()
    {
        var json = """{ "id": "d1", "role": "developer", "content": "instructions" }""";

        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        var developer = Assert.IsType<AGUIDeveloperMessage>(deserialized);
        Assert.Equal("d1", developer.Id);
        Assert.Equal("instructions", developer.Content);
    }

    [Fact]
    public void NameAndEncryptedValue_RoundTrip()
    {
        AGUIMessage message = new AGUIDeveloperMessage
        {
            Id = "d1",
            Content = "c",
            Name = "system-author",
            EncryptedValue = "enc",
        };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        var developer = Assert.IsType<AGUIDeveloperMessage>(deserialized);
        Assert.Equal("system-author", developer.Name);
        Assert.Equal("enc", developer.EncryptedValue);
    }
}
