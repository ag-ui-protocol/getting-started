using System.Collections.Generic;
using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

public sealed class AGUIUserContentTest
{
    [Fact]
    public void ImplicitFromString_StoresTextAndSurfacesAsSingleTextPart()
    {
        AGUIUserContent content = "hello";

        Assert.True(content.IsText);
        Assert.Equal("hello", content.Value);
        var single = Assert.Single(content);
        Assert.Equal("hello", Assert.IsType<AGUITextInputContent>(single).Text);
    }

    [Fact]
    public void ImplicitFromList_StoresPartsAndIsNotText()
    {
        var parts = new List<AGUIInputContent>
        {
            new AGUITextInputContent { Text = "a" },
            new AGUITextInputContent { Text = "b" },
        };

        AGUIUserContent content = parts;

        Assert.False(content.IsText);
        Assert.Equal(2, content.Count);
        Assert.Equal("a", Assert.IsType<AGUITextInputContent>(content[0]).Text);
        Assert.Equal("b", Assert.IsType<AGUITextInputContent>(content[1]).Text);
    }

    [Fact]
    public void CollectionExpression_InitializesParts()
    {
        AGUIUserContent content = [new AGUITextInputContent { Text = "x" }, new AGUITextInputContent { Text = "y" }];

        Assert.False(content.IsText);
        Assert.Collection(
            content,
            part => Assert.Equal("x", Assert.IsType<AGUITextInputContent>(part).Text),
            part => Assert.Equal("y", Assert.IsType<AGUITextInputContent>(part).Text));
    }

    [Fact]
    public void Default_IsEmpty()
    {
        AGUIUserContent content = default;

        Assert.Null(content.Value);
        Assert.False(content.IsText);
        Assert.Empty(content);
    }

    [Fact]
    public void UserMessage_StringContent_SerializesAsJsonString()
    {
        AGUIMessage message = new AGUIUserMessage { Id = "u1", Content = "hello" };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("user", doc.RootElement.GetProperty("role").GetString());
        var contentElement = doc.RootElement.GetProperty("content");
        Assert.Equal(JsonValueKind.String, contentElement.ValueKind);
        Assert.Equal("hello", contentElement.GetString());
    }

    [Fact]
    public void UserMessage_MultipleParts_SerializesAsArray()
    {
        AGUIMessage message = new AGUIUserMessage
        {
            Id = "u1",
            Content = [new AGUITextInputContent { Text = "a" }, new AGUITextInputContent { Text = "b" }],
        };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        using var doc = JsonDocument.Parse(json);

        var contentElement = doc.RootElement.GetProperty("content");
        Assert.Equal(JsonValueKind.Array, contentElement.ValueKind);
        Assert.Equal(2, contentElement.GetArrayLength());
        Assert.Equal("text", contentElement[0].GetProperty("type").GetString());
    }

    [Fact]
    public void UserMessage_StringContent_RoundTrips()
    {
        AGUIMessage message = new AGUIUserMessage { Id = "u1", Content = "round trip" };

        var json = JsonSerializer.Serialize(message, AGUIJsonSerializerContext.Default.AGUIMessage);
        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        var user = Assert.IsType<AGUIUserMessage>(deserialized);
        Assert.Equal("round trip", Assert.IsType<AGUITextInputContent>(Assert.Single(user.Content)).Text);
    }

    [Fact]
    public void UserMessage_DeserializesStringContent_AsSingleTextPart()
    {
        var json = """{ "id": "u1", "role": "user", "content": "hi there" }""";

        var deserialized = JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.AGUIMessage);

        var user = Assert.IsType<AGUIUserMessage>(deserialized);
        var part = Assert.Single(user.Content);
        Assert.Equal("hi there", Assert.IsType<AGUITextInputContent>(part).Text);
    }
}
