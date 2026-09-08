using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class AgenticChatExtraTests
{
    private readonly TsServerFixture _fixture;

    public AgenticChatExtraTests(TsServerFixture fixture) => _fixture = fixture;

    private AGUIChatClient Client(HttpClient http) => new(new(http, $"{_fixture.BaseUrl}/agentic_chat"));

    [Fact]
    public async Task MultiTurnContext_FullHistoryIsForwarded()
    {
        // The fake agent echoes the FIRST user message back when prompted with
        // "first question"; that only works if AGUIChatClient sends the full
        // chat history (not just the last turn) on the second call.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = Client(http);
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatMessage> history =
        [
            new(ChatRole.User, "Hi, I am duaa"),
            new(ChatRole.Assistant, "Hello duaa! How can I assist you today?"),
            new(ChatRole.User, "What was my first question?"),
        ];

        string text = await StreamText(client, history, cts.Token);
        Assert.Contains("duaa", text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task LongChunkedText_IsReassembled()
    {
        // The fake agent emits the reply broken into 2-character deltas
        // (chunkSize=2 in textMessage()). AGUIChatClient must concatenate
        // every TEXT_MESSAGE_CONTENT delta into the final ChatResponseUpdate
        // text — losing any chunk breaks the assertion.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = Client(http);
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        string text = await StreamText(
            client,
            [new(ChatRole.User, "Please count to ten")],
            cts.Token);

        // Verify every digit 1..10 made the round-trip in order.
        Assert.Equal("1 2 3 4 5 6 7 8 9 10", text);
    }

    [Fact]
    public async Task NameMemory_AcrossTwoTurns()
    {
        // Same fixture pattern as the dojo v1AgenticChat spec: introduce
        // a name in turn one, ask the model to recall it in turn two.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = Client(http);
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        string turn1 = await StreamText(
            client,
            [new(ChatRole.User, "Hello, my name is Alex")],
            cts.Token);
        Assert.Contains("Alex", turn1);

        string turn2 = await StreamText(
            client,
            [
                new(ChatRole.User, "Hello, my name is Alex"),
                new(ChatRole.Assistant, turn1),
                new(ChatRole.User, "What is my name?"),
            ],
            cts.Token);
        Assert.Contains("Alex", turn2);
    }

    private static async Task<string> StreamText(
        AGUIChatClient client,
        IEnumerable<ChatMessage> messages,
        CancellationToken cancellationToken)
    {
        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(messages, cancellationToken: cancellationToken)
            .ConfigureAwait(false))
        {
            updates.Add(update);
        }
        return string.Concat(updates.Select(u => u.Text));
    }
}
