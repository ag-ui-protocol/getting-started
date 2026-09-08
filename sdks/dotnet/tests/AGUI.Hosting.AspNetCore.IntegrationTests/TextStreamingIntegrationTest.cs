using System.Linq;
using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class TextStreamingIntegrationTest : IntegrationTestBase
{
    public TextStreamingIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_TextContent_MapsToTextMessageEvents(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitTextResponse("Hello world!", ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        // AGUIChatClient is stateless: it never surfaces a ConversationId (issue #4869).
        // Updates are correlated by ResponseId instead.
        Assert.All(updates, u =>
        {
            Assert.Null(u.ConversationId);
            Assert.NotNull(u.ResponseId);
        });

        Assert.Collection(updates,
            u =>
            {
                Assert.Equal(ChatRole.Assistant, u.Role);
                Assert.IsType<RunStartedEvent>(u.RawRepresentation);
            },
            u =>
            {
                Assert.Equal(ChatRole.Assistant, u.Role);
                Assert.Equal("Hello world!", u.Text);
                Assert.Single(u.Contents.OfType<TextContent>());
                var textContent = Assert.IsType<TextMessageContentEvent>(u.RawRepresentation);
                Assert.Equal("Hello world!", textContent.Delta);
            },
            u =>
            {
                Assert.Equal(ChatRole.Assistant, u.Role);
                Assert.Equal(ChatFinishReason.Stop, u.FinishReason);
                Assert.IsType<RunFinishedEvent>(u.RawRepresentation);
            });
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_MultiTurn_MessagesConvertedFromChatToAGUI(TransportFormat format)
    {
        var capturedMessages = new List<IList<ChatMessage>>();

        var turns = new Queue<Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>>>();
        turns.Enqueue((messages, options, ct) =>
        {
            capturedMessages.Add(messages.ToList());
            return EmitTextResponse("Response to turn 1", ct);
        });
        turns.Enqueue((messages, options, ct) =>
        {
            capturedMessages.Add(messages.ToList());
            return EmitTextResponse("Response to turn 2", ct);
        });

        var client = CreateClient((messages, options, ct) => turns.Dequeue()(messages, options, ct), format);

        // Turn 1 - user sends first message
        var updates1 = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hello")]);

        Assert.Single(capturedMessages[0]);
        Assert.Equal(ChatRole.User, capturedMessages[0][0].Role);

        var text1 = ExtractText(updates1);
        Assert.Equal("Response to turn 1", text1);

        // Turn 2 - user sends previous messages plus new message
        var turn2Messages = new List<ChatMessage>
        {
            new ChatMessage(ChatRole.User, "Hello"),
            new ChatMessage(ChatRole.Assistant, "Response to turn 1"),
            new ChatMessage(ChatRole.User, "Follow up")
        };
        var updates2 = await CollectUpdates(client, turn2Messages);

        Assert.Equal(3, capturedMessages[1].Count);
        Assert.Equal(ChatRole.User, capturedMessages[1][0].Role);
        Assert.Equal(ChatRole.Assistant, capturedMessages[1][1].Role);
        Assert.Equal(ChatRole.User, capturedMessages[1][2].Role);

        var text2 = ExtractText(updates2);
        Assert.Equal("Response to turn 2", text2);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_Streaming_YieldsTextContent(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitTextResponse("Hello via ChatClient!", ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        var textUpdates = updates.Where(u => !string.IsNullOrEmpty(u.Text)).ToList();
        Assert.Single(textUpdates);
        Assert.Equal("Hello via ChatClient!", textUpdates[0].Text);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_MultiTurn_ViaGetResponseAsync(TransportFormat format)
    {
        var turns = new Queue<Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>>>();
        turns.Enqueue((messages, options, ct) => EmitTextResponse("First response", ct));
        turns.Enqueue((messages, options, ct) => EmitTextResponse("Second response", ct));

        var client = CreateClient((messages, options, ct) => turns.Dequeue()(messages, options, ct), format);

        // Turn 1
        var messages = new List<ChatMessage>
        {
            new ChatMessage(ChatRole.User, "Hello")
        };
        var response1 = await client.GetResponseAsync(messages);
        var text1 = string.Concat(response1.Messages
            .SelectMany(m => m.Contents.OfType<TextContent>())
            .Select(t => t.Text));
        Assert.Equal("First response", text1);

        // Turn 2 - add assistant response and new user message
        messages.Add(new ChatMessage(ChatRole.Assistant, "First response"));
        messages.Add(new ChatMessage(ChatRole.User, "Follow up"));

        var response2 = await client.GetResponseAsync(messages);
        var text2 = string.Concat(response2.Messages
            .SelectMany(m => m.Contents.OfType<TextContent>())
            .Select(t => t.Text));
        Assert.Equal("Second response", text2);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_AuthorName_RoundTrips(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitTextResponseWithAuthorName("Hello!", "TestAgent", ct), format);

        var updates = await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")]);

        var textUpdate = updates.FirstOrDefault(u => !string.IsNullOrEmpty(u.Text));
        Assert.NotNull(textUpdate);
        Assert.Equal("TestAgent", textUpdate.AuthorName);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitTextResponseWithAuthorName(
        string text, string authorName,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            AuthorName = authorName,
            MessageId = Guid.NewGuid().ToString("N"),
            Contents = [new TextContent(text)]
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
