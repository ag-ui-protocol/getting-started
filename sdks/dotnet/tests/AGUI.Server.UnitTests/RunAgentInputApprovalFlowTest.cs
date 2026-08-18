using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class RunAgentInputApprovalFlowTest
{
    private static readonly JsonSerializerOptions s_jsonOptions = CreateJsonOptions();

    [Fact]
    public async Task FirstTurn_MixedCallsStopBeforeServerExecution()
    {
        var serverExecutions = 0;
        var serverTool = AIFunctionFactory.Create(
            () =>
            {
                serverExecutions++;
                return "server-result";
            },
            "server_tool");
        var context = CreateContext(CreateInput(), serverTool);
        var clientTool = Assert.IsType<ApprovalRequiredAIFunction>(context.ChatOptions.Tools![0]);
        Assert.True(JsonElement.DeepEquals(
            CreateClientTool().Parameters,
            clientTool.JsonSchema));
        using var ficc = new FunctionInvokingChatClient(
            new CallbackChatClient((_, _, ct) => EmitCalls(
                [CreateCall("client-1", "client_tool"), CreateCall("server-1", "server_tool")],
                ct)));

        var updates = await CollectUpdates(
            ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));
        var approvals = updates.SelectMany(update => update.Contents)
            .OfType<ToolApprovalRequestContent>()
            .ToList();

        Assert.Equal(0, serverExecutions);
        Assert.Equal(2, approvals.Count);
#pragma warning disable MEAI001
        Assert.True(approvals.Single(request => request.ToolCall.CallId == "client-1").RequiresConfirmation);
        Assert.False(approvals.Single(request => request.ToolCall.CallId == "server-1").RequiresConfirmation);
#pragma warning restore MEAI001
    }

    [Fact]
    public async Task Continuation_ApprovesAllCallsAndReusesResultsByCallId()
    {
        var serverExecutions = new Dictionary<string, int>(StringComparer.Ordinal);
        var serverTool = AIFunctionFactory.Create(
            (string value) =>
            {
                serverExecutions[value] = serverExecutions.GetValueOrDefault(value) + 1;
                return $"server:{value}";
            },
            "server_tool");
        FunctionCallContent[] calls =
        [
            CreateCall("client-1", "client_tool", "first"),
            CreateCall("server-1", "server_tool", "alpha"),
            CreateCall("client-2", "client_tool", "second"),
            CreateCall("server-2", "server_tool", "beta"),
        ];
        var input = CreateInput(calls);
        input.Resume =
        [
            CreateClientResume(calls[0], "client:first"),
            CreateApprovalResume(calls[1], approved: true, result: null),
            CreateClientResume(calls[2], "client:second"),
            CreateApprovalResume(calls[3], approved: true, result: null),
        ];
        var context = CreateContext(input, serverTool);
        Assert.True(context.IsContinuation);
        AssertApprovalBatch(
            context.Messages,
            calls.Select(call => call.CallId),
            calls.Select(call => call.CallId));

        List<ChatMessage>? providerMessages = null;
        using var ficc = new FunctionInvokingChatClient(
            new CallbackChatClient((messages, _, ct) =>
            {
                providerMessages = messages.Select(message => message.Clone()).ToList();
                return EmitText("complete", ct);
            }));

        var updates = await CollectUpdates(
            ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));

        Assert.Equal(1, serverExecutions["alpha"]);
        Assert.Equal(1, serverExecutions["beta"]);
        AssertCompleteHistory(
            providerMessages!,
            calls.Select(call => call.CallId),
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
            events.OfType<ToolCallResultEvent>().Select(result => result.ToolCallId).OrderBy(id => id));
    }

    [Theory]
    [InlineData(true, 1, "server-result")]
    [InlineData(false, 0, "Tool call invocation rejected.")]
    public async Task Continuation_PreservesGenuineServerApproval(
        bool approved,
        int expectedServerExecutions,
        string expectedServerResult)
    {
        var serverExecutions = 0;
        var serverTool = new ApprovalRequiredAIFunction(AIFunctionFactory.Create(
            () =>
            {
                serverExecutions++;
                return "server-result";
            },
            "server_tool"));
        var clientCall = CreateCall("client-1", "client_tool");
        var serverCall = CreateCall("server-1", "server_tool");
        var input = CreateInput([clientCall, serverCall]);
        input.Resume =
        [
            CreateClientResume(clientCall, "client-result"),
            CreateApprovalResume(serverCall, approved, result: null),
        ];
        var context = CreateContext(input, serverTool);
        AssertApprovalBatch(
            context.Messages,
            ["client-1", "server-1"],
            ["client-1", "server-1"]);

        List<ChatMessage>? providerMessages = null;
        using var ficc = new FunctionInvokingChatClient(
            new CallbackChatClient((messages, _, ct) =>
            {
                providerMessages = messages.Select(message => message.Clone()).ToList();
                return EmitText("complete", ct);
            }));

        _ = await CollectUpdates(ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));

        Assert.Equal(expectedServerExecutions, serverExecutions);
        AssertCompleteHistory(
            providerMessages!,
            ["client-1", "server-1"],
            new Dictionary<string, string>
            {
                ["client-1"] = "client-result",
                ["server-1"] = expectedServerResult,
            });
    }

    [Fact]
    public void NewTurn_DoesNotReuseHistoricalClientResult()
    {
        var input = CreateInput(
            [CreateCall("client-old", "client_tool")],
            new Dictionary<string, string> { ["client-old"] = "old-result" });
        input.Messages.Add(new AGUIAssistantMessage { Content = "finished" });
        input.Messages.Add(new AGUIUserMessage { Content = "new turn" });

        var context = input.ToChatRequestContext(s_jsonOptions);

        Assert.False(context.IsContinuation);
        Assert.IsType<ApprovalRequiredAIFunction>(Assert.Single(context.ChatOptions.Tools!));
        Assert.DoesNotContain(
            context.Messages.SelectMany(message => message.Contents),
            content => content is ToolApprovalRequestContent);
    }

    [Fact]
    public async Task Continuation_NewClientCallStopsForFreshExecution()
    {
        var context = CreateContext(CreateInput(
            [CreateCall("client-1", "client_tool")],
            new Dictionary<string, string> { ["client-1"] = "old-result" }));
        using var ficc = new FunctionInvokingChatClient(
            new CallbackChatClient((_, _, ct) => EmitCalls(
                [CreateCall("client-2", "client_tool")],
                ct)));

        var updates = await CollectUpdates(
            ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));

        var approval = Assert.Single(
            updates.SelectMany(update => update.Contents)
                .OfType<ToolApprovalRequestContent>());
        Assert.Equal("client-2", approval.ToolCall.CallId);
#pragma warning disable MEAI001
        Assert.True(approval.RequiresConfirmation);
#pragma warning restore MEAI001
    }

    [Fact]
    public async Task Resume_NullClientResultIsReturnedByProxy()
    {
        var clientCall = CreateCall("client-1", "client_tool");
        var input = CreateInput([clientCall]);
        input.Resume = [CreateClientResume(clientCall, result: null)];
        var context = CreateContext(input);
        List<ChatMessage>? providerMessages = null;
        using var ficc = new FunctionInvokingChatClient(
            new CallbackChatClient((messages, _, ct) =>
            {
                providerMessages = messages.Select(message => message.Clone()).ToList();
                return EmitText("complete", ct);
            }));

        _ = await CollectUpdates(ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions));

        var result = Assert.Single(
            providerMessages!.SelectMany(message => message.Contents)
                .OfType<FunctionResultContent>());
        Assert.Equal("client-1", result.CallId);
        Assert.Null(result.Result);
    }

    [Fact]
    public void Resume_StaleClientResultIsRejected()
    {
        var clientCall = CreateCall("client-old", "client_tool");
        var input = CreateInput([clientCall]);
        input.Messages.Add(new AGUIAssistantMessage { Content = "finished" });
        input.Messages.Add(new AGUIUserMessage { Content = "new turn" });
        input.Resume = [CreateClientResume(clientCall, "old-result")];

        var exception = Assert.Throws<InvalidOperationException>(
            () => input.ToChatRequestContext(s_jsonOptions));

        Assert.Contains("latest unresolved tool-call batch", exception.Message);
    }

    [Fact]
    public void Resume_SubstitutedToolArgumentsAreRejected()
    {
        var originalCall = CreateCall("client-1", "client_tool", "original");
        var substitutedCall = CreateCall("client-1", "client_tool", "substituted");
        var input = CreateInput([originalCall]);
        input.Resume = [CreateClientResume(originalCall, "result", substitutedCall)];

        var exception = Assert.Throws<InvalidOperationException>(
            () => input.ToChatRequestContext(s_jsonOptions));

        Assert.Contains("does not match its original tool call", exception.Message);
    }

    [Fact]
    public void Resume_IncompleteCallBatchIsRejected()
    {
        var clientCall = CreateCall("client-1", "client_tool");
        var protectedServerCall = CreateCall("server-1", "server_tool");
        var omittedServerCall = CreateCall("server-2", "other_server_tool");
        var input = CreateInput([clientCall, protectedServerCall, omittedServerCall]);
        input.Resume =
        [
            CreateClientResume(clientCall, "client-result"),
            CreateApprovalResume(protectedServerCall, approved: true, result: null),
        ];

        var exception = Assert.Throws<InvalidOperationException>(
            () => input.ToChatRequestContext(s_jsonOptions));

        Assert.Contains("complete latest unresolved tool-call batch", exception.Message);
    }

    [Fact]
    public void LegacyResult_MixedCallBatchRequiresResume()
    {
        var input = CreateInput(
            [
                CreateCall("client-1", "client_tool"),
                CreateCall("server-1", "server_tool"),
            ],
            new Dictionary<string, string> { ["client-1"] = "client-result" });

        var exception = Assert.Throws<InvalidOperationException>(
            () => input.ToChatRequestContext(s_jsonOptions));

        Assert.Contains("require a complete approval Resume batch", exception.Message);
    }

    [Fact]
    public void LegacyResult_CompletedMixedBatchDoesNotResume()
    {
        var input = CreateInput(
            [
                CreateCall("client-1", "client_tool"),
                CreateCall("server-1", "server_tool"),
            ],
            new Dictionary<string, string> { ["client-1"] = "client-result" });
        input.Messages.Add(new AGUIToolMessage
        {
            ToolCallId = "server-1",
            Content = "server-result",
        });

        var context = input.ToChatRequestContext(s_jsonOptions);

        Assert.False(context.IsContinuation);
        Assert.DoesNotContain(
            context.Messages.SelectMany(message => message.Contents),
            content => content is ToolApprovalRequestContent);
    }

    [Fact]
    public void Resume_CompletedMixedBatchIsRejected()
    {
        var clientCall = CreateCall("client-1", "client_tool");
        var serverCall = CreateCall("server-1", "server_tool");
        var input = CreateInput(
            [clientCall, serverCall],
            new Dictionary<string, string> { ["client-1"] = "client-result" });
        input.Messages.Add(new AGUIToolMessage
        {
            ToolCallId = "server-1",
            Content = "server-result",
        });
        input.Resume =
        [
            CreateClientResume(clientCall, "client-result"),
            CreateApprovalResume(serverCall, approved: true, result: null),
        ];

        var exception = Assert.Throws<InvalidOperationException>(
            () => input.ToChatRequestContext(s_jsonOptions));

        Assert.Contains("complete latest unresolved tool-call batch", exception.Message);
    }

    private static ChatRequestContext CreateContext(RunAgentInput input, params AITool[] serverTools)
    {
        var context = input.ToChatRequestContext(s_jsonOptions);
        context.ChatOptions.Tools ??= [];
        foreach (var serverTool in serverTools)
        {
            context.ChatOptions.Tools.Add(serverTool);
        }

        return context;
    }

    private static RunAgentInput CreateInput(
        IReadOnlyList<FunctionCallContent>? calls = null,
        IReadOnlyDictionary<string, string>? clientResults = null)
    {
        var messages = new List<AGUIMessage>
        {
            new AGUIUserMessage { Content = "run tools" },
        };

        if (calls is not null)
        {
            messages.Add(new AGUIAssistantMessage
            {
                ToolCalls = calls.Select(ToAGUICall).ToList(),
            });
        }

        if (clientResults is not null)
        {
            foreach (var result in clientResults)
            {
                messages.Add(new AGUIToolMessage
                {
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
            Tools = [CreateClientTool()],
        };
    }

    private static AGUITool CreateClientTool() =>
        new()
        {
            Name = "client_tool",
            Description = "Runs on the client.",
            Parameters = JsonDocument.Parse("""
                {
                    "type": "object",
                    "properties": {
                        "value": { "type": "string" }
                    }
                }
                """).RootElement.Clone(),
        };

    private static AGUIToolCall ToAGUICall(FunctionCallContent call) =>
        new()
        {
            Id = call.CallId,
            Function = new AGUIToolCallFunction
            {
                Name = call.Name,
                Arguments = JsonSerializer.Serialize(
                    call.Arguments,
                    s_jsonOptions.GetTypeInfo(typeof(IDictionary<string, object?>))),
            },
        };

    private static FunctionCallContent CreateCall(
        string callId,
        string name,
        string? value = null) =>
        new(
            callId,
            name,
            value is null ? null : new Dictionary<string, object?> { ["value"] = value });

    private static AGUIResume CreateClientResume(
        FunctionCallContent call,
        string? result,
        FunctionCallContent? resumedCall = null) =>
        CreateApprovalResume(resumedCall ?? call, approved: true, result);

    private static AGUIResume CreateApprovalResume(
        FunctionCallContent call,
        bool approved,
        string? result) =>
        new()
        {
            InterruptId = $"approval_{call.CallId}",
            Status = ResumeStatus.Resolved,
            Payload = JsonSerializer.SerializeToElement(
                new AGUIToolApprovalResumePayload
                {
                    Approved = approved,
                    ToolCall = new AGUIToolCallInfo
                    {
                        CallId = call.CallId,
                        Name = call.Name,
                        Arguments = call.Arguments,
                    },
                    Result = result,
                },
                s_jsonOptions.GetTypeInfo(typeof(AGUIToolApprovalResumePayload))),
        };

    private static void AssertApprovalBatch(
        List<ChatMessage> messages,
        IEnumerable<string> expectedCallIds,
        IEnumerable<string> expectedConfirmedCallIds)
    {
        var requests = messages.SelectMany(message => message.Contents)
            .OfType<ToolApprovalRequestContent>()
            .ToList();
        var responses = messages.SelectMany(message => message.Contents)
            .OfType<ToolApprovalResponseContent>()
            .ToList();

        Assert.Equal(expectedCallIds.OrderBy(id => id), requests.Select(request => request.ToolCall.CallId).OrderBy(id => id));
        Assert.Equal(expectedCallIds.OrderBy(id => id), responses.Select(response => response.ToolCall.CallId).OrderBy(id => id));
#pragma warning disable MEAI001
        Assert.Equal(
            expectedConfirmedCallIds,
            requests.Where(request => request.RequiresConfirmation)
                .Select(request => request.ToolCall.CallId)
                .ToList());
#pragma warning restore MEAI001
    }

    private static void AssertCompleteHistory(
        List<ChatMessage> messages,
        IEnumerable<string> expectedCallIds,
        IReadOnlyDictionary<string, string> expectedResults)
    {
        var assistantIndex = messages.FindLastIndex(
            message => message.Role == ChatRole.Assistant
                && message.Contents.OfType<FunctionCallContent>().Any());
        Assert.True(assistantIndex >= 0);
        var calls = messages[assistantIndex].Contents.OfType<FunctionCallContent>().ToList();
        var results = messages.Skip(assistantIndex + 1)
            .TakeWhile(message => message.Role == ChatRole.Tool)
            .SelectMany(message => message.Contents)
            .OfType<FunctionResultContent>()
            .ToList();

        Assert.Equal(expectedCallIds.OrderBy(id => id), calls.Select(call => call.CallId).OrderBy(id => id));
        Assert.Equal(expectedCallIds.OrderBy(id => id), results.Select(result => result.CallId).OrderBy(id => id));
        foreach (var expected in expectedResults)
        {
            Assert.Equal(expected.Value, results.Single(result => result.CallId == expected.Key).Result?.ToString());
        }
    }

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(AGUIJsonSerializerContext.Default.Options);
        options.TypeInfoResolverChain.Insert(0, AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
        AGUI.Abstractions.AGUIJsonUtilities.RegisterInterruptContentTypes(options);
        return options;
    }

    private static async Task<List<ChatResponseUpdate>> CollectUpdates(
        IAsyncEnumerable<ChatResponseUpdate> updates)
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
