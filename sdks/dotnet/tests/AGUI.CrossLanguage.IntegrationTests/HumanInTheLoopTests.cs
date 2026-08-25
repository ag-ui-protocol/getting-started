using AGUI.Client;
using Microsoft.Extensions.AI;

namespace AGUI.CrossLanguage.IntegrationTests;

[Collection(nameof(TsServerCollection))]
public sealed class HumanInTheLoopTests
{
    private readonly TsServerFixture _fixture;

    public HumanInTheLoopTests(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ToolApprovalRoundTrip_ApproveCompletesSuccessfully()
    {
        await RunApprovalScenario(approved: true, expectedReply: "Files deleted as requested");
    }

    [Fact]
    public async Task ToolApprovalRoundTrip_RejectionIsRelayed()
    {
        await RunApprovalScenario(approved: false, expectedReply: "Skipping deletion");
    }

    private async Task RunApprovalScenario(bool approved, string expectedReply)
    {
        // First call: the fake agent emits a TOOL_CALL for delete_files and
        // finishes with an interrupt outcome whose reason="tool_call" points
        // at that tool call. The C# AGUIChatClient materialises this as a
        // ToolApprovalRequestContent rather than a plain FunctionCallContent.
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(10) };
        AGUIChatClient client = new(new(http, $"{_fixture.BaseUrl}/human_in_the_loop"));
        using CancellationTokenSource cts = new(TimeSpan.FromSeconds(20));

        List<ChatMessage> messages = [new(ChatRole.User, "Clean up /tmp/cache")];

        ChatResponse firstResponse = await client.GetResponseAsync(messages, cancellationToken: cts.Token).ConfigureAwait(false);

        ToolApprovalRequestContent? approvalRequest = firstResponse.Messages
            .SelectMany(m => m.Contents)
            .OfType<ToolApprovalRequestContent>()
            .FirstOrDefault();
        Assert.NotNull(approvalRequest);
        FunctionCallContent toolCall = Assert.IsType<FunctionCallContent>(approvalRequest!.ToolCall);
        Assert.Equal("delete_files", toolCall.Name);

        // Second call: append the assistant message that surfaced the
        // approval request, then a user message containing the approval
        // response. AGUIChatClient extracts the ToolApprovalResponseContent
        // and forwards it as a resume payload to the server.
        messages.AddRange(firstResponse.Messages);
        messages.Add(new ChatMessage(ChatRole.User,
        [
            new ToolApprovalResponseContent(approvalRequest.RequestId, approved, toolCall),
        ]));

        ChatResponse secondResponse = await client.GetResponseAsync(messages, cancellationToken: cts.Token).ConfigureAwait(false);

        string text = string.Concat(secondResponse.Messages
            .SelectMany(m => m.Contents)
            .OfType<TextContent>()
            .Select(t => t.Text));
        Assert.Contains(expectedReply, text);
    }
}

