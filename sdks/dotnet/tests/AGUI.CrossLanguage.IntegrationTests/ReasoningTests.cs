using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class ReasoningTests
{
    private readonly TsServerFixture _fixture;

    public ReasoningTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ReasoningEvents_SurfaceAsTextReasoningContent()
    {
        // The fake agent emits REASONING_MESSAGE_START / _CONTENT / _END
        // before the final assistant text. EventStreamConverter materializes
        // REASONING_MESSAGE_CONTENT into TextReasoningContent on the update's
        // Contents, so the C# client can render the model's thinking
        // separately from its final answer (matching the dojo reasoning UI).
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/reasoning"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "What is 2 + 2?")],
                cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        TextReasoningContent[] reasoningContents = updates
            .SelectMany(u => u.Contents)
            .OfType<TextReasoningContent>()
            .ToArray();
        Assert.NotEmpty(reasoningContents);

        string reasoning = string.Concat(reasoningContents.Select(r => r.Text));
        Assert.Contains("Considering the question", reasoning);
        Assert.Contains("2 + 2 must equal 4", reasoning);

        // The final answer text comes through as the usual TextContent.
        string answer = string.Concat(updates.Select(u => u.Text));
        Assert.Contains("Four", answer);
    }
}
