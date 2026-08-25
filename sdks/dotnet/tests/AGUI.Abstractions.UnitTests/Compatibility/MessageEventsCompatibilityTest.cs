using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests.Compatibility;

public sealed class MessageEventsCompatibilityTest
{
    private readonly JsonElement[] _fixtures = FixtureLoader.LoadFixture("message-events.json");

    [Fact]
    public void TextMessageStart_WithTimestamp_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[0]);

        var typed = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal("assistant", typed.Role);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void TextMessageStart_Minimal_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[1]);

        var typed = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal("assistant", typed.Role);
    }

    [Fact]
    public void TextMessageStart_UserRole_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[2]);

        var typed = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("test-msg", typed.MessageId);
        Assert.Equal("user", typed.Role);
    }

    [Fact]
    public void TextMessageStart_DeveloperRole_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[3]);

        var typed = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("test-msg-developer", typed.MessageId);
        Assert.Equal("developer", typed.Role);
    }

    [Fact]
    public void TextMessageStart_SystemRole_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[4]);

        var typed = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("test-msg-system", typed.MessageId);
        Assert.Equal("system", typed.Role);
    }

    [Fact]
    public void TextMessageStart_WithName_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[5]);

        var typed = Assert.IsType<TextMessageStartEvent>(evt);
        Assert.Equal("test-msg-named", typed.MessageId);
        Assert.Equal("assistant", typed.Role);
        Assert.Equal("TestAgent", typed.Name);
    }

    [Fact]
    public void TextMessageContent_Basic_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[6]);

        var typed = Assert.IsType<TextMessageContentEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal("Hello, how can I help you today?", typed.Delta);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void TextMessageContent_SpecialCharacters_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[7]);

        var typed = Assert.IsType<TextMessageContentEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Contains("\ud83d\ude80", typed.Delta); // rocket emoji
        Assert.Contains("\u00f1", typed.Delta); // ñ
    }

    [Fact]
    public void TextMessageEnd_DeserializesFromTypeScriptPayload()
    {
        var evt = FixtureLoader.DeserializeAsBaseEvent(_fixtures[8]);

        var typed = Assert.IsType<TextMessageEndEvent>(evt);
        Assert.Equal("msg-1", typed.MessageId);
        Assert.Equal(1234567890, typed.Timestamp);
    }

    [Fact]
    public void AllMessageEvents_RoundTrip_PreservesType()
    {
        foreach (var fixture in _fixtures)
        {
            var evt = FixtureLoader.DeserializeAsBaseEvent(fixture);
            var reserialized = JsonSerializer.Serialize(evt, AGUIJsonSerializerContext.Default.BaseEvent);
            var reDeserialized = JsonSerializer.Deserialize<BaseEvent>(reserialized, AGUIJsonSerializerContext.Default.BaseEvent)!;

            Assert.Equal(evt.Type, reDeserialized.Type);
        }
    }
}
