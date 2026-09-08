using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

public sealed class TextMessageBuilderTest
{
    [Fact]
    public void EmitTextUpdate_ReturnsUpdateWithTextContent()
    {
        var builder = new TextMessageBuilder();
        builder.SetConversationAndResponseIds("thread-1", "run-1");
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "assistant" });

        var update = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-1", Delta = "Hello" });

        Assert.Equal(ChatRole.Assistant, update.Role);
        Assert.Equal("Hello", update.Text);
        Assert.Equal("thread-1", update.ConversationId);
        Assert.Equal("run-1", update.ResponseId);
        Assert.Equal("msg-1", update.MessageId);
    }

    [Fact]
    public void EmitTextUpdate_MapsUserRole()
    {
        var builder = new TextMessageBuilder();
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "user" });

        var update = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-1", Delta = "test" });

        Assert.Equal(ChatRole.User, update.Role);
    }

    [Fact]
    public void EmitTextUpdate_MapsSystemRole()
    {
        var builder = new TextMessageBuilder();
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "system" });

        var update = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-1", Delta = "test" });

        Assert.Equal(ChatRole.System, update.Role);
    }

    [Fact]
    public void EmitTextUpdate_MapsCustomRole()
    {
        var builder = new TextMessageBuilder();
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "developer" });

        var update = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-1", Delta = "test" });

        Assert.Equal(new ChatRole("developer"), update.Role);
    }

    [Fact]
    public void EndCurrentMessage_ResetsState()
    {
        var builder = new TextMessageBuilder();
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "assistant" });
        builder.EndCurrentMessage(new TextMessageEndEvent { MessageId = "msg-1" });

        // Should be able to start a new message without throwing
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-2", Role = "user" });
    }

    [Fact]
    public void AddTextStart_SupportsConcurrentMessages()
    {
        var builder = new TextMessageBuilder();
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "assistant" });

        // Concurrent messages with different IDs are allowed
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-2", Role = "user" });

        var update1 = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-1", Delta = "Hello" });
        var update2 = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-2", Delta = "World" });

        Assert.Equal(ChatRole.Assistant, update1.Role);
        Assert.Equal(ChatRole.User, update2.Role);
    }

    [Fact]
    public void EndCurrentMessage_RemovesMessageById()
    {
        var builder = new TextMessageBuilder();
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "assistant" });
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-2", Role = "user" });

        builder.EndCurrentMessage(new TextMessageEndEvent { MessageId = "msg-1" });

        // msg-2 should still be active and emit with correct role
        var update = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-2", Delta = "test" });
        Assert.Equal(ChatRole.User, update.Role);
    }

    [Fact]
    public void EmitTextUpdate_WithName_SetsAuthorName()
    {
        var builder = new TextMessageBuilder();
        builder.SetConversationAndResponseIds("thread-1", "run-1");
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "assistant", Name = "TestAgent" });

        var update = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-1", Delta = "Hello" });

        Assert.Equal("TestAgent", update.AuthorName);
    }

    [Fact]
    public void EmitTextUpdate_WithoutName_AuthorNameIsNull()
    {
        var builder = new TextMessageBuilder();
        builder.AddTextStart(new TextMessageStartEvent { MessageId = "msg-1", Role = "assistant" });

        var update = builder.EmitTextUpdate(new TextMessageContentEvent { MessageId = "msg-1", Delta = "Hello" });

        Assert.Null(update.AuthorName);
    }
}
