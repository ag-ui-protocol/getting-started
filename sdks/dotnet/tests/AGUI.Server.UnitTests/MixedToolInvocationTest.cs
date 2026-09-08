using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class MixedToolInvocationTest
{
    /// <summary>
    /// Proves that when both server and client tools are wrapped with ApprovalRequiredAIFunction:
    /// 1. First turn: LLM emits both FCCs → FICC converts all to ToolApprovalRequestContent
    /// 2. Second turn (resume): both tools execute — server tool runs real implementation,
    ///    client tool proxy returns pre-computed result — and LLM gets all results.
    /// </summary>
    [Fact]
    public async Task MixedInvocation_ApprovalFlow_ExecutesBothToolsOnResume()
    {
        // --- Setup ---
        // Server tool: real implementation that runs on the server
        var serverToolInvoked = false;
        string ServerGetWeather(string city)
        {
            serverToolInvoked = true;
            return $"Weather in {city}: 22°C, sunny";
        }

        // Client tool: on the first turn, this is a placeholder (won't be invoked because approval is required).
        // On the resume turn, it will be replaced with a proxy that returns the pre-computed result.
        string ClientGetLocationPlaceholder()
        {
            throw new InvalidOperationException("Should not be invoked on first turn");
        }

        var serverTool = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create(ServerGetWeather, "get_weather", "Gets the weather for a city"));
        var clientToolPlaceholder = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create(ClientGetLocationPlaceholder, "get_user_location", "Gets the user's GPS location"));

        var turnIndex = 0;
        List<ChatMessage>? llmMessagesOnResume = null;
        var fakeLlm = new CallbackChatClient((messages, options, ct) =>
        {
            turnIndex++;
            return turnIndex switch
            {
                // Turn 1: LLM emits both tool calls in one response
                1 => EmitMixedToolCalls(ct),
                // Turn 2 (after resume, FICC invoked both tools): LLM produces final text
                2 => CaptureAndEmitText(messages, ref llmMessagesOnResume,
                    "Based on the weather in Amsterdam (22°C, sunny) and your location, I recommend visiting Vondelpark!"),
                _ => throw new InvalidOperationException($"Unexpected turn {turnIndex}")
            };
        });

        // Build the FICC pipeline: FICC → FakeLLM
        var ficc = new ChatClientBuilder(fakeLlm)
            .UseFunctionInvocation()
            .Build();

        // --- Turn 1: First call - should produce ToolApprovalRequestContent for both tools ---
        var messages1 = new List<ChatMessage>
        {
            new(ChatRole.User, "What's the weather near me?")
        };
        var options1 = new ChatOptions
        {
            Tools = new List<AITool> { serverTool, clientToolPlaceholder }
        };

        var updates1 = await CollectStreamingUpdates(ficc, messages1, options1);

        // Verify: both tools are returned as ToolApprovalRequestContent
        var approvalRequests = updates1
            .SelectMany(u => u.Contents)
            .OfType<ToolApprovalRequestContent>()
            .ToList();

        Assert.Equal(2, approvalRequests.Count);
        var serverApproval = approvalRequests.Single(a => ((FunctionCallContent)a.ToolCall).Name == "get_weather");
        var clientApproval = approvalRequests.Single(a => ((FunctionCallContent)a.ToolCall).Name == "get_user_location");

        Assert.False(serverToolInvoked, "Server tool should NOT be invoked on first turn");

        // --- Turn 2: Resume with approvals ---
        // Simulate what the client would do:
        // 1. Client executed get_user_location locally → got "Amsterdam, Netherlands"
        // 2. Client approved get_weather for server execution
        // 3. Client sends resume with both

        // On resume, we replace the client tool with a proxy that returns the pre-computed result
        var preComputedClientResult = "Amsterdam, Netherlands (52.37°N, 4.90°E)";
        string ClientGetLocationProxy()
        {
            return preComputedClientResult;
        }

        var clientToolProxy = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create(ClientGetLocationProxy, "get_user_location", "Gets the user's GPS location"));

        // Build messages with approval history for BOTH tools
        var serverToolCall = (FunctionCallContent)serverApproval.ToolCall;
        var clientToolCall = (FunctionCallContent)clientApproval.ToolCall;

        var messages2 = new List<ChatMessage>
        {
            new(ChatRole.User, "What's the weather near me?"),
            // Approval request/response for server tool
            new(ChatRole.Assistant, [new ToolApprovalRequestContent(serverApproval.RequestId, serverToolCall)]),
            new(ChatRole.User, [new ToolApprovalResponseContent(serverApproval.RequestId, approved: true, serverToolCall)]),
            // Approval request/response for client tool
            new(ChatRole.Assistant, [new ToolApprovalRequestContent(clientApproval.RequestId, clientToolCall)]),
            new(ChatRole.User, [new ToolApprovalResponseContent(clientApproval.RequestId, approved: true, clientToolCall)]),
        };

        var options2 = new ChatOptions
        {
            // Key: server tool stays the same, client tool is now a PROXY
            Tools = new List<AITool> { serverTool, clientToolProxy }
        };

        // Reset turn counter for second FICC call
        turnIndex = 1; // Next call to LLM will be turn 2

        var updates2 = await CollectStreamingUpdates(ficc, messages2, options2);

        // Verify: server tool WAS invoked on the server
        Assert.True(serverToolInvoked, "Server tool should be invoked on resume");

        // Verify: final text response from LLM was received
        var finalText = string.Concat(updates2
            .Where(u => !string.IsNullOrEmpty(u.Text))
            .Select(u => u.Text));
        Assert.Contains("Vondelpark", finalText);

        // Verify: LLM received FunctionResultContent for BOTH tools on the resume turn
        Assert.NotNull(llmMessagesOnResume);
        var allResults = llmMessagesOnResume!
            .SelectMany(m => m.Contents)
            .OfType<FunctionResultContent>()
            .ToList();
        Assert.Equal(2, allResults.Count);

        var weatherResult = allResults.Single(r => r.CallId == "call_weather_1");
        Assert.Contains("22°C, sunny", weatherResult.Result?.ToString());

        var locationResult = allResults.Single(r => r.CallId == "call_location_1");
        Assert.Contains("Amsterdam", locationResult.Result?.ToString());
    }

    /// <summary>
    /// Proves that if the LLM re-issues the client tool AFTER the resume (with a new call ID),
    /// ApprovalRequiredAIFunction triggers a NEW interrupt — preventing stale cached results.
    /// </summary>
    [Fact]
    public async Task MixedInvocation_LlmReissuesClientTool_TriggersNewInterrupt()
    {
        // Server tool
        string ServerGetWeather(string city) => $"Weather in {city}: 22°C, sunny";

        // Client tool proxy (returns cached result from first invocation)
        string ClientGetLocationProxy() => "Amsterdam, Netherlands";

        var serverTool = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create(ServerGetWeather, "get_weather", "Gets the weather for a city"));
        var clientToolProxy = new ApprovalRequiredAIFunction(
            AIFunctionFactory.Create(ClientGetLocationProxy, "get_user_location", "Gets the user's GPS location"));

        var turnIndex = 0;
        var fakeLlm = new CallbackChatClient((messages, options, ct) =>
        {
            turnIndex++;
            return turnIndex switch
            {
                // Turn 1 (after resume, both pre-approved): FICC invokes both, then calls LLM with results
                // LLM decides to call the client tool AGAIN with a different call ID
                1 => EmitSingleToolCall("call_location_2", "get_user_location",
                    new Dictionary<string, object?> { ["format"] = "coordinates_only" }, ct),
                _ => throw new InvalidOperationException($"Unexpected turn {turnIndex}")
            };
        });

        var ficc = new ChatClientBuilder(fakeLlm)
            .UseFunctionInvocation()
            .Build();

        // Simulate a resume turn where both tools were already approved for the FIRST call
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "What's the weather near me?"),
            // Original approval for server tool
            new(ChatRole.Assistant, [new ToolApprovalRequestContent("req_1",
                new FunctionCallContent("call_weather_1", "get_weather",
                    new Dictionary<string, object?> { ["city"] = "Amsterdam" }))]),
            new(ChatRole.User, [new ToolApprovalResponseContent("req_1", approved: true,
                new FunctionCallContent("call_weather_1", "get_weather",
                    new Dictionary<string, object?> { ["city"] = "Amsterdam" }))]),
            // Original approval for client tool
            new(ChatRole.Assistant, [new ToolApprovalRequestContent("req_2",
                new FunctionCallContent("call_location_1", "get_user_location",
                    new Dictionary<string, object?>()))]),
            new(ChatRole.User, [new ToolApprovalResponseContent("req_2", approved: true,
                new FunctionCallContent("call_location_1", "get_user_location",
                    new Dictionary<string, object?>()))]),
        };

        var options = new ChatOptions
        {
            Tools = new List<AITool> { serverTool, clientToolProxy }
        };

        var updates = await CollectStreamingUpdates(ficc, messages, options);

        // The LLM issued call_location_2 (new call ID, no pre-approval for this one)
        // ApprovalRequiredAIFunction should trigger a NEW ToolApprovalRequestContent
        var newApprovalRequests = updates
            .SelectMany(u => u.Contents)
            .OfType<ToolApprovalRequestContent>()
            .ToList();

        Assert.Single(newApprovalRequests);
        var newApproval = newApprovalRequests[0];
        Assert.Equal("get_user_location", ((FunctionCallContent)newApproval.ToolCall).Name);
        Assert.Equal("call_location_2", ((FunctionCallContent)newApproval.ToolCall).CallId);
    }

    [Fact]
    public async Task MixedInvocation_ServerOnlyTools_ExecuteWithoutApproval()
    {
        // When there are NO client tools (only server tools without ApprovalRequired),
        // they execute normally without the approval flow.
        var toolInvoked = false;
        string GetWeather(string city)
        {
            toolInvoked = true;
            return $"Weather in {city}: 22°C";
        }

        var serverTool = AIFunctionFactory.Create(GetWeather, "get_weather", "Gets the weather");

        var turnIndex = 0;
        var fakeLlm = new CallbackChatClient((messages, options, ct) =>
        {
            turnIndex++;
            return turnIndex switch
            {
                1 => EmitSingleToolCall("call_1", "get_weather",
                    new Dictionary<string, object?> { ["city"] = "Amsterdam" }, ct),
                2 => EmitTextResponse("The weather in Amsterdam is 22°C.", ct),
                _ => throw new InvalidOperationException()
            };
        });

        var ficc = new ChatClientBuilder(fakeLlm)
            .UseFunctionInvocation()
            .Build();

        var messages = new List<ChatMessage> { new(ChatRole.User, "Weather in Amsterdam?") };
        var options = new ChatOptions { Tools = [serverTool] };

        var updates = await CollectStreamingUpdates(ficc, messages, options);

        Assert.True(toolInvoked);
        var text = string.Concat(updates.Where(u => !string.IsNullOrEmpty(u.Text)).Select(u => u.Text));
        Assert.Contains("22°C", text);
    }

#pragma warning disable CS1998
    private static async IAsyncEnumerable<ChatResponseUpdate> EmitMixedToolCalls(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents =
            [
                new FunctionCallContent("call_weather_1", "get_weather",
                    new Dictionary<string, object?> { ["city"] = "Amsterdam" }),
                new FunctionCallContent("call_location_1", "get_user_location",
                    new Dictionary<string, object?>())
            ],
            FinishReason = ChatFinishReason.ToolCalls
        };
    }

    private static IAsyncEnumerable<ChatResponseUpdate> CaptureAndEmitText(
        IEnumerable<ChatMessage> messages,
        ref List<ChatMessage>? capturedMessages,
        string text)
    {
        capturedMessages = messages.ToList();
        return EmitTextResponse(text);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitSingleToolCall(
        string callId, string name, IDictionary<string, object?> arguments,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent(callId, name, arguments)],
            FinishReason = ChatFinishReason.ToolCalls
        };
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitTextResponse(
        string text,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new TextContent(text)],
            MessageId = $"msg_{Guid.NewGuid():N}"
        };
    }
#pragma warning restore CS1998

    private static async Task<List<ChatResponseUpdate>> CollectStreamingUpdates(
        IChatClient client,
        IList<ChatMessage> messages,
        ChatOptions? options = null)
    {
        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync(messages, options).ConfigureAwait(false))
        {
            updates.Add(update);
        }
        return updates;
    }

    /// <summary>
    /// Simple callback-based chat client for testing.
    /// </summary>
    private sealed class CallbackChatClient : IChatClient
    {
        private readonly Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> _handler;

        public CallbackChatClient(
            Func<IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> handler)
        {
            _handler = handler;
        }

        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default)
        {
            return _handler(messages, options, cancellationToken);
        }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default)
        {
            throw new NotSupportedException();
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose() { }
    }
}
