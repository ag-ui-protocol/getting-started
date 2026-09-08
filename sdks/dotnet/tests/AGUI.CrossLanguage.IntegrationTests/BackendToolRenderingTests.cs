using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class BackendToolRenderingTests
{
    private readonly TsServerFixture _fixture;

    public BackendToolRenderingTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ReceivesToolCallAndFollowUpText()
    {
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/backend_tool_rendering"));

        ChatMessage[] messages =
        [
            new(ChatRole.User, "What is the weather in Paris?"),
        ];

        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(messages, cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        // The TS fake-agent emits TOOL_CALL_START / _ARGS / _END / _RESULT
        // followed by TEXT_MESSAGE_* deltas summarising the result. Verify
        // both flow through AGUIChatClient: a FunctionCallContent for the
        // tool invocation, a FunctionResultContent for the tool result, and
        // text content for the follow-up message.
        FunctionCallContent? toolCall = updates
            .SelectMany(u => u.Contents)
            .OfType<FunctionCallContent>()
            .FirstOrDefault();
        Assert.NotNull(toolCall);
        Assert.Equal("get_weather", toolCall!.Name);
        Assert.Contains("Paris", System.Text.Json.JsonSerializer.Serialize(toolCall.Arguments));

        FunctionResultContent? toolResult = updates
            .SelectMany(u => u.Contents)
            .OfType<FunctionResultContent>()
            .FirstOrDefault();
        Assert.NotNull(toolResult);
        Assert.Contains("Paris", toolResult!.Result?.ToString() ?? string.Empty);

        string text = string.Concat(updates.Select(u => u.Text));
        Assert.Matches("72.*Paris|Paris.*72", text);
    }
}
