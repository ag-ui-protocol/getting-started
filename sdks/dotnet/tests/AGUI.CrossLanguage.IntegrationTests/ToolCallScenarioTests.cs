using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class ToolCallScenarioTests
{
    private readonly TsServerFixture _fixture;

    public ToolCallScenarioTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task FrontendOnlyToolCall_ArgsReassembledAcrossManyChunks()
    {
        // The fake agent emits TOOL_CALL_ARGS chunks of 4 characters each
        // and never sends a TOOL_CALL_RESULT — modelling a frontend-only
        // tool whose execution belongs to the client. AGUIChatClient must
        // (a) reassemble the JSON args from every delta and surface them as
        // a FunctionCallContent, and (b) NOT fabricate a FunctionResultContent.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/frontend_only_tool"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "Set the background to blue")],
                cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        FunctionCallContent? toolCall = updates
            .SelectMany(u => u.Contents)
            .OfType<FunctionCallContent>()
            .FirstOrDefault();
        Assert.NotNull(toolCall);
        Assert.Equal("change_background", toolCall!.Name);

        // The args must be exactly the JSON the fake agent sent, even
        // though it was split across 4-character TOOL_CALL_ARGS chunks.
        string argsJson = JsonSerializer.Serialize(toolCall.Arguments);
        Assert.Contains("blue", argsJson);
        Assert.Contains("indigo", argsJson);
        Assert.Contains("high", argsJson);

        // No result was sent over the wire; AGUIChatClient must not invent one.
        FunctionResultContent? toolResult = updates
            .SelectMany(u => u.Contents)
            .OfType<FunctionResultContent>()
            .FirstOrDefault();
        Assert.Null(toolResult);
    }

    [Fact]
    public async Task MultiMessageRun_PreservesOrderAcrossAssistantToolAssistant()
    {
        // The fake agent emits: assistant text -> tool call -> tool result
        // -> assistant text, all in a single run. AGUIChatClient must keep
        // them in order so the resulting ChatResponseUpdate stream has both
        // text chunks and the function call/result in the right sequence.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/multi_message_run"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatResponseUpdate> updates = [];
        await foreach (ChatResponseUpdate update in client
            .GetStreamingResponseAsync(
                [new(ChatRole.User, "Look up the answer")],
                cancellationToken: cts.Token))
        {
            updates.Add(update);
        }

        // Each TEXT_MESSAGE_CONTENT becomes its own ChatResponseUpdate, so
        // collapse them by MessageId to discover the assistant turn boundaries
        // before doing the order assertion. The pre-tool message is identified
        // by its first words; the post-tool one by the literal "42".
        int preTextIdx = -1, toolCallIdx = -1, toolResultIdx = -1, postTextIdx = -1;
        var seenMessageTexts = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < updates.Count; i++)
        {
            ChatResponseUpdate u = updates[i];
            if (u.MessageId is string id && !string.IsNullOrEmpty(u.Text))
            {
                string accumulated = seenMessageTexts.TryGetValue(id, out string? existing) ? existing + u.Text : u.Text;
                seenMessageTexts[id] = accumulated;
                if (preTextIdx < 0 && accumulated.Contains("check that for you", StringComparison.OrdinalIgnoreCase))
                {
                    preTextIdx = i;
                }
                if (postTextIdx < 0 && accumulated.Contains("42", StringComparison.Ordinal))
                {
                    postTextIdx = i;
                }
            }
            foreach (AIContent c in u.Contents)
            {
                if (toolCallIdx < 0 && c is FunctionCallContent)
                {
                    toolCallIdx = i;
                }
                if (toolResultIdx < 0 && c is FunctionResultContent)
                {
                    toolResultIdx = i;
                }
            }
        }

        Assert.True(preTextIdx >= 0, "expected pre-tool assistant text 'check that for you'");
        Assert.True(toolCallIdx > preTextIdx, "tool call should follow pre-tool text");
        Assert.True(toolResultIdx > toolCallIdx, "tool result should follow tool call");
        Assert.True(postTextIdx > toolResultIdx, "post-tool text should follow tool result");
    }
}
