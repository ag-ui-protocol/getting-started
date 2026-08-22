using System.Linq;
using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class ToolCallIntegrationTest : IntegrationTestBase
{
    public ToolCallIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_FunctionCallContent_MapsToToolCallEvents(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitToolCallResponse("call-1", "get_weather",
                new Dictionary<string, object?> { ["location"] = "Seattle" }, ct), format);

        var updates = await CollectUpdates(
            client,
            [new ChatMessage(ChatRole.User, "Hi")],
            new ChatOptions { Tools = [DummyClientTool] });

        Assert.Collection(updates,
            u =>
            {
                Assert.Equal(ChatRole.Assistant, u.Role);
                Assert.Null(u.ConversationId);
                Assert.NotNull(u.ResponseId);
                Assert.IsType<RunStartedEvent>(u.RawRepresentation);
            },
            u =>
            {
                Assert.Equal(ChatRole.Assistant, u.Role);
                var toolEnd = Assert.IsType<ToolCallEndEvent>(u.RawRepresentation);
                Assert.Equal("call-1", toolEnd.ToolCallId);
                var fcc = Assert.Single(u.Contents.OfType<FunctionCallContent>());
                Assert.Equal("get_weather", fcc.Name);
                Assert.Equal("call-1", fcc.CallId);
                Assert.NotNull(fcc.Arguments);
                Assert.Equal("Seattle", fcc.Arguments!["location"]?.ToString());
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
    public async Task PostRun_SequentialToolCalls_EmitsAllEventsInOrder(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitSequentialToolCalls(ct), format);

        var updates = await CollectUpdates(
            client,
            [new ChatMessage(ChatRole.User, "Hi")],
            new ChatOptions { Tools = [DummyClientTool] });

        // Should have: RunStarted, ToolCall1, ToolCall2, RunFinished
        Assert.Equal(4, updates.Count);

        Assert.Equal(ChatRole.Assistant, updates[0].Role);
        Assert.IsType<RunStartedEvent>(updates[0].RawRepresentation);

        Assert.Equal(ChatRole.Assistant, updates[1].Role);
        var tool1 = Assert.IsType<ToolCallEndEvent>(updates[1].RawRepresentation);
        Assert.Equal("c1", tool1.ToolCallId);
        var fcc1 = Assert.Single(updates[1].Contents.OfType<FunctionCallContent>());
        Assert.Equal("get_weather", fcc1.Name);

        Assert.Equal(ChatRole.Assistant, updates[2].Role);
        var tool2 = Assert.IsType<ToolCallEndEvent>(updates[2].RawRepresentation);
        Assert.Equal("c2", tool2.ToolCallId);
        var fcc2 = Assert.Single(updates[2].Contents.OfType<FunctionCallContent>());
        Assert.Equal("get_time", fcc2.Name);

        Assert.Equal(ChatFinishReason.Stop, updates[3].FinishReason);
        Assert.IsType<RunFinishedEvent>(updates[3].RawRepresentation);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_ToolCallInterleavedWithText_BothEmitted(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitToolCallWithText(ct), format);

        var updates = await CollectUpdates(
            client,
            [new ChatMessage(ChatRole.User, "Hi")],
            new ChatOptions { Tools = [DummyClientTool] });

        // RunStarted, TextContent, ToolCall, RunFinished
        Assert.Equal(4, updates.Count);
        Assert.IsType<RunStartedEvent>(updates[0].RawRepresentation);

        Assert.Equal(ChatRole.Assistant, updates[1].Role);
        Assert.Equal("Let me check the weather. ", updates[1].Text);
        Assert.Single(updates[1].Contents.OfType<TextContent>());
        var textContent = Assert.IsType<TextMessageContentEvent>(updates[1].RawRepresentation);
        Assert.Equal("Let me check the weather. ", textContent.Delta);

        Assert.Equal(ChatRole.Assistant, updates[2].Role);
        var toolEnd = Assert.IsType<ToolCallEndEvent>(updates[2].RawRepresentation);
        Assert.Equal("call-1", toolEnd.ToolCallId);
        var fcc = Assert.Single(updates[2].Contents.OfType<FunctionCallContent>());
        Assert.Equal("get_weather", fcc.Name);

        Assert.Equal(ChatFinishReason.Stop, updates[3].FinishReason);
        Assert.IsType<RunFinishedEvent>(updates[3].RawRepresentation);
    }

    // Json-only: this scenario emits a FunctionResultContent that maps to a TOOL_CALL_RESULT
    // event. ToolCallResult is a .NET-only event with no protobuf representation, so the
    // protobuf server encoder throws NotSupportedException. The decoded behavior is otherwise
    // covered by the JSON run.
    [Fact]
    public async Task PostRun_ToolCallResultEvent_StreamedAsToolCallUpdate()
    {
        var client = CreateClient((messages, options, ct) =>
            EmitToolCallWithResultResponse(
                "call-1", "get_weather",
                new Dictionary<string, object?> { ["location"] = "Seattle" },
                "{\"temp\":72}",
                ct));

        var updates = await CollectUpdates(
            client,
            [new ChatMessage(ChatRole.User, "Hi")],
            new ChatOptions { Tools = [DummyClientTool] });

        // The tool call should be present as FunctionCallContent
        var toolCallUpdate = updates.FirstOrDefault(u => u.Contents.OfType<FunctionCallContent>().Any());
        Assert.NotNull(toolCallUpdate);
        Assert.Equal(ChatRole.Assistant, toolCallUpdate!.Role);
        Assert.Null(toolCallUpdate.ConversationId);
        Assert.NotNull(toolCallUpdate.ResponseId);
        var fcc = toolCallUpdate.Contents.OfType<FunctionCallContent>().Single();
        Assert.Equal("call-1", fcc.CallId);
        Assert.Equal("get_weather", fcc.Name);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_ToolCallWithNullArgs_MapsToFunctionCallContentWithNullArgs(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitToolCallResponse("call-1", "ping", null, ct), format);

        var updates = await CollectUpdates(
            client,
            [new ChatMessage(ChatRole.User, "Hi")],
            new ChatOptions { Tools = [DummyClientTool] });

        var toolCallUpdate = updates.FirstOrDefault(u => u.Contents.OfType<FunctionCallContent>().Any());
        Assert.NotNull(toolCallUpdate);
        Assert.Equal(ChatRole.Assistant, toolCallUpdate!.Role);
        Assert.NotNull(toolCallUpdate.ResponseId);

        var toolEnd = Assert.IsType<ToolCallEndEvent>(toolCallUpdate.RawRepresentation);
        Assert.Equal("call-1", toolEnd.ToolCallId);

        var fcc = toolCallUpdate.Contents.OfType<FunctionCallContent>().Single();
        Assert.Equal("ping", fcc.Name);
        Assert.Equal("call-1", fcc.CallId);
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_ContinuationStreamsGenuinelyNewToolCall(TransportFormat format)
    {
        var client = CreateClient((messages, options, ct) =>
            EmitToolCallResponse(
                "call-new",
                "next_step",
                new Dictionary<string, object?> { ["value"] = 42 },
                ct),
            format);
        var confirmTool = AIFunctionFactory.Create(
            () => "confirmed",
            "confirm",
            "Confirms an action");

        var updates = await CollectUpdates(
            client,
            [
                new ChatMessage(ChatRole.Assistant,
                [
                    new FunctionCallContent("call-existing", "confirm",
                        new Dictionary<string, object?>())
                ]),
                new ChatMessage(ChatRole.Tool,
                [
                    new FunctionResultContent("call-existing", """{"choice":"yes"}""")
                ])
            ],
            new ChatOptions { Tools = [confirmTool] });

        Assert.Collection(updates,
            u => Assert.IsType<RunStartedEvent>(u.RawRepresentation),
            u =>
            {
                var toolEnd = Assert.IsType<ToolCallEndEvent>(u.RawRepresentation);
                Assert.Equal("call-new", toolEnd.ToolCallId);
                var call = Assert.Single(u.Contents.OfType<FunctionCallContent>());
                Assert.Equal("call-new", call.CallId);
                Assert.Equal("next_step", call.Name);
                Assert.Equal("42", call.Arguments!["value"]?.ToString());
            },
            u => Assert.IsType<RunFinishedEvent>(u.RawRepresentation));
    }

    // A dummy client tool so AGUIChatClient treats unmatched tool calls as server tools
    // and passes them through instead of letting FunctionInvokingChatClient loop on them.
    private static readonly AIFunction DummyClientTool = AIFunctionFactory.Create(
        (string x) => x,
        "_dummy_client_tool",
        "Dummy client tool for testing");

    // Helper methods for emitting ChatResponseUpdate sequences

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitSequentialToolCalls(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent("c1", "get_weather",
                new Dictionary<string, object?> { ["location"] = "Seattle" })]
        };
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent("c2", "get_time",
                new Dictionary<string, object?> { ["timezone"] = "PST" })],
            FinishReason = ChatFinishReason.ToolCalls
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitToolCallWithText(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        // Text first
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new TextContent("Let me check the weather. ")]
        };

        // Then tool call
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent("call-1", "get_weather",
                new Dictionary<string, object?> { ["location"] = "Seattle" })],
            FinishReason = ChatFinishReason.ToolCalls
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
