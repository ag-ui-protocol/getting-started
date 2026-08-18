using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class RunAgentInputMixedInvocationTest
{
    private static readonly JsonSerializerOptions s_jsonOptions = CreateJsonOptions();

    [Fact]
    public async Task FirstTurn_ClientProxyStopsMixedBatchAndClassifiesApprovals()
    {
        var serverExecutions = 0;
        var serverTool = AIFunctionFactory.Create(
            () =>
            {
                serverExecutions++;
                return "server";
            },
            "server_tool");
        var input = CreateInput(
            [CreateCall("client-1", "client_tool"), CreateCall("server-1", "server_tool")],
            clientResults: null);
        var context = CreateContext(input, serverTool);
        var inner = new CallbackChatClient((_, _, ct) => EmitCalls(
            [CreateFunctionCall("client-1", "client_tool"), CreateFunctionCall("server-1", "server_tool")],
            ct));
        using var ficc = new FunctionInvokingChatClient(inner);

        var updates = await CollectUpdates(ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));
        var approvals = updates.SelectMany(u => u.Contents).OfType<ToolApprovalRequestContent>().ToList();

        Assert.Equal(2, approvals.Count);
#pragma warning disable MEAI001
        Assert.True(approvals.Single(a => a.ToolCall.CallId == "client-1").RequiresConfirmation);
        Assert.False(approvals.Single(a => a.ToolCall.CallId == "server-1").RequiresConfirmation);
#pragma warning restore MEAI001
        Assert.Equal(0, serverExecutions);

        var events = await CollectEvents(updates, context);
        Assert.Equal(["client-1", "server-1"], events.OfType<ToolCallStartEvent>().Select(e => e.ToolCallId));
        Assert.IsNotType<RunFinishedInterruptOutcome>(Assert.IsType<RunFinishedEvent>(events[^1]).Outcome);
    }

    [Fact]
    public async Task Continuation_MultipleCallsReuseExactClientResultsAndExecuteServerCallsOnce()
    {
        var serverExecutions = new Dictionary<string, int>(StringComparer.Ordinal);
        string ExecuteServer(string value)
        {
            serverExecutions[value] = serverExecutions.GetValueOrDefault(value) + 1;
            return $"server:{value}";
        }

        var serverTool = AIFunctionFactory.Create((string value) => ExecuteServer(value), "server_tool");
        FunctionCallContent[] calls =
        [
            CreateFunctionCall("client-1", "client_tool", "first"),
            CreateFunctionCall("server-1", "server_tool", "alpha"),
            CreateFunctionCall("client-2", "client_tool", "second"),
            CreateFunctionCall("server-2", "server_tool", "beta"),
        ];
        var input = CreateInput(
            calls.Select(ToAGUICall).ToList(),
            new Dictionary<string, string>
            {
                ["client-1"] = "client:first",
                ["client-2"] = "client:second",
            });
        var context = CreateContext(input, serverTool);
        List<ChatMessage>? providerMessages = null;
        var inner = new CallbackChatClient((messages, _, ct) =>
        {
            providerMessages = messages.Select(m => m.Clone()).ToList();
            return EmitText("complete", ct);
        });
        using var ficc = new FunctionInvokingChatClient(inner);

        var updates = await CollectUpdates(ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));

        Assert.Equal(1, serverExecutions["alpha"]);
        Assert.Equal(1, serverExecutions["beta"]);
        AssertProviderHistoryIsComplete(providerMessages!, calls.Select(c => c.CallId),
            new Dictionary<string, string>
            {
                ["client-1"] = "client:first",
                ["client-2"] = "client:second",
                ["server-1"] = "server:alpha",
                ["server-2"] = "server:beta",
            });

        var events = await CollectEvents(updates, context);
        Assert.Empty(events.OfType<ToolCallStartEvent>());
        Assert.Equal(
            ["server-1", "server-2"],
            events.OfType<ToolCallResultEvent>().Select(e => e.ToolCallId).OrderBy(id => id));
        Assert.Single(events.OfType<TextMessageStartEvent>());
        Assert.Single(events.OfType<TextMessageEndEvent>());
    }

    [Theory]
    [InlineData(false, 0, "Tool call invocation rejected.")]
    [InlineData(true, 1, "server")]
    public async Task Continuation_ExistingServerApprovalIsPreserved(
        bool approved,
        int expectedExecutions,
        string expectedResult)
    {
        var serverExecutions = 0;
        var serverTool = new ApprovalRequiredAIFunction(AIFunctionFactory.Create(
            () =>
            {
                serverExecutions++;
                return "server";
            },
            "server_tool"));
        var clientCall = CreateFunctionCall("client-1", "client_tool");
        var serverCall = CreateFunctionCall("server-1", "server_tool");
        var input = CreateInput(
            [ToAGUICall(clientCall), ToAGUICall(serverCall)],
            new Dictionary<string, string> { ["client-1"] = "client-result" });
        input.Resume =
        [
            new AGUIResume
            {
                InterruptId = "approval-server-1",
                Status = ResumeStatus.Resolved,
                Payload = JsonSerializer.SerializeToElement(
                    new AGUIToolApprovalResumePayload
                    {
                        Approved = approved,
                        ToolCall = new AGUIToolCallInfo
                        {
                            CallId = serverCall.CallId,
                            Name = serverCall.Name,
                            Arguments = serverCall.Arguments,
                        },
                    },
                    s_jsonOptions.GetTypeInfo(typeof(AGUIToolApprovalResumePayload))),
            },
        ];
        var context = CreateContext(input, serverTool);
        List<ChatMessage>? providerMessages = null;
        var inner = new CallbackChatClient((messages, _, ct) =>
        {
            providerMessages = messages.Select(m => m.Clone()).ToList();
            return EmitText("rejected", ct);
        });
        using var ficc = new FunctionInvokingChatClient(inner);

        _ = await CollectUpdates(ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));

        Assert.Equal(expectedExecutions, serverExecutions);
        AssertProviderHistoryIsComplete(providerMessages!, ["client-1", "server-1"],
            new Dictionary<string, string>
            {
                ["client-1"] = "client-result",
                ["server-1"] = expectedResult,
            });
    }

    [Fact]
    public void RepeatedTurn_HistoricalClientResultDoesNotTriggerContinuation()
    {
        var input = CreateInput(
            [CreateCall("client-old", "client_tool")],
            new Dictionary<string, string> { ["client-old"] = "old-result" });
        input.Messages.Add(new AGUIAssistantMessage { Id = "assistant-final", Content = "finished" });
        input.Messages.Add(new AGUIUserMessage { Id = "user-2", Content = "start a new turn" });

        var context = input.ToChatRequestContext(s_jsonOptions);

        Assert.False(context.IsContinuation);
        var clientTool = Assert.Single(context.ChatOptions.Tools!);
        Assert.NotNull(clientTool.GetService<ApprovalRequiredAIFunction>());
        Assert.Contains(
            context.Messages.SelectMany(message => message.Contents),
            content => content is FunctionResultContent { CallId: "client-old" });
        Assert.DoesNotContain(
            context.Messages.SelectMany(message => message.Contents),
            content => content is ToolApprovalRequestContent);
    }

    private static ChatRequestContext CreateContext(RunAgentInput input, params AITool[] serverTools)
    {
        var context = input.ToChatRequestContext(s_jsonOptions);
        context.ChatOptions.Tools ??= [];
        foreach (var tool in serverTools)
        {
            context.ChatOptions.Tools.Add(tool);
        }

        return context;
    }

    private static RunAgentInput CreateInput(
        IList<AGUIToolCall> calls,
        IReadOnlyDictionary<string, string>? clientResults)
    {
        var messages = new List<AGUIMessage>
        {
            new AGUIUserMessage { Id = "user-1", Content = "run tools" },
        };

        if (clientResults is not null)
        {
            messages.Add(new AGUIAssistantMessage { Id = "assistant-1", ToolCalls = calls });
            foreach (var result in clientResults)
            {
                messages.Add(new AGUIToolMessage
                {
                    Id = $"result-{result.Key}",
                    ToolCallId = result.Key,
                    Content = result.Value,
                });
            }
        }

        return new RunAgentInput
        {
            ThreadId = "thread-1",
            RunId = "run-1",
            Messages = messages,
            Tools =
            [
                new AGUITool
                {
                    Name = "client_tool",
                    Description = "Runs on the client.",
                    Parameters = JsonDocument.Parse("""{"type":"object"}""").RootElement.Clone(),
                },
            ],
        };
    }

    private static AGUIToolCall CreateCall(string callId, string name) =>
        ToAGUICall(CreateFunctionCall(callId, name));

    private static AGUIToolCall ToAGUICall(FunctionCallContent call) =>
        new()
        {
            Id = call.CallId,
            Function = new AGUIToolCallFunction
            {
                Name = call.Name,
                Arguments = JsonSerializer.Serialize(call.Arguments, s_jsonOptions.GetTypeInfo(typeof(IDictionary<string, object?>))),
            },
        };

    private static FunctionCallContent CreateFunctionCall(string callId, string name, string? value = null) =>
        new(callId, name, value is null ? null : new Dictionary<string, object?> { ["value"] = value });

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(AGUIJsonSerializerContext.Default.Options);
        options.TypeInfoResolverChain.Insert(0, AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
        AGUI.Abstractions.AGUIJsonUtilities.RegisterInterruptContentTypes(options);
        return options;
    }

    private static async Task<List<ChatResponseUpdate>> CollectUpdates(IAsyncEnumerable<ChatResponseUpdate> updates)
    {
        var result = new List<ChatResponseUpdate>();
        await foreach (var update in updates.ConfigureAwait(false))
        {
            result.Add(update);
        }

        return result;
    }

    private static async Task<List<BaseEvent>> CollectEvents(
        List<ChatResponseUpdate> updates,
        ChatRequestContext context)
    {
        var events = new List<BaseEvent>();
        await foreach (var evt in Replay(updates).AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        return events;
    }

    private static void AssertProviderHistoryIsComplete(
        List<ChatMessage> messages,
        IEnumerable<string> expectedCallIds,
        IReadOnlyDictionary<string, string> expectedResults)
    {
        var assistantIndex = messages.FindLastIndex(
            m => m.Role == ChatRole.Assistant && m.Contents.OfType<FunctionCallContent>().Any());
        Assert.True(assistantIndex >= 0);
        Assert.True(assistantIndex + 1 < messages.Count);

        var calls = messages[assistantIndex].Contents.OfType<FunctionCallContent>().ToList();
        var results = new List<FunctionResultContent>();
        for (var i = assistantIndex + 1; i < messages.Count && messages[i].Role == ChatRole.Tool; i++)
        {
            results.AddRange(messages[i].Contents.OfType<FunctionResultContent>());
        }

        var expectedIds = expectedCallIds.OrderBy(id => id).ToList();
        var actualIds = calls.Select(c => c.CallId).OrderBy(id => id).ToList();
        Assert.True(
            expectedIds.SequenceEqual(actualIds),
            string.Join(
                Environment.NewLine,
                messages.Select((message, index) =>
                    $"{index}:{message.Role} calls=[{string.Join(",", message.Contents.OfType<FunctionCallContent>().Select(c => c.CallId))}] results=[{string.Join(",", message.Contents.OfType<FunctionResultContent>().Select(r => r.CallId))}]")));
        Assert.Equal(expectedIds, results.Select(r => r.CallId).OrderBy(id => id));
        foreach (var expected in expectedResults)
        {
            Assert.Equal(expected.Value, results.Single(r => r.CallId == expected.Key).Result?.ToString());
        }
    }

#pragma warning disable CS1998
    private static async IAsyncEnumerable<ChatResponseUpdate> EmitCalls(
        IList<FunctionCallContent> calls,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, calls.Cast<AIContent>().ToList())
        {
            FinishReason = ChatFinishReason.ToolCalls,
        };
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitText(
        string text,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, [new TextContent(text)]);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> Replay(
        IEnumerable<ChatResponseUpdate> updates)
    {
        foreach (var update in updates)
        {
            yield return update;
        }
    }
#pragma warning restore CS1998

    private sealed class CallbackChatClient(
        Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> callback)
        : IChatClient
    {
        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default) =>
            callback(messages, options, cancellationToken);

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }
}
