using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class AgenticChatTests
{
    private readonly TsServerFixture _fixture;

    public AgenticChatTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task RawHttp_TsServer_Responds()
    {
        // Smoke probe that bypasses AGUIChatClient — pure HttpClient call.
        // If this passes but the AGUIChatClient test below fails, the issue
        // is in the C# client's SSE pipeline, not the fixture/test plumbing.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        using StringContent body = new(
            """{"threadId":"t","runId":"r","messages":[{"id":"u","role":"user","content":"Hi, I am duaa"}],"tools":[],"context":[],"state":{},"forwardedProps":{}}""",
            System.Text.Encoding.UTF8,
            "application/json");

        using HttpResponseMessage response = await http.PostAsync($"{_fixture.BaseUrl}/agentic_chat", body);
        string content = await response.Content.ReadAsStringAsync();

        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("Hello", content);
    }

    [Fact]
    public async Task ReceivesTextResponse_ForSimpleGreeting()
    {
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/agentic_chat"));

        ChatMessage[] messages =
        [
            new(ChatRole.User, "Hi, I am duaa"),
        ];

        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(messages, cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        // The TS server splits the reply across multiple TEXT_MESSAGE_CONTENT
        // deltas; AGUIChatClient must concatenate them into the final text.
        string fullText = string.Concat(updates.Select(u => u.Text));
        Assert.Matches("Hello.*duaa", fullText);
    }
}


