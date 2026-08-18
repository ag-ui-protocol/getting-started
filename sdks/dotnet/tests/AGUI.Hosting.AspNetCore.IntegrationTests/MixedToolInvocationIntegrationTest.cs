using System.Runtime.CompilerServices;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using AGUI.Abstractions;
using AGUI.Client;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Xunit;

namespace AGUI.Server.IntegrationTests;

/// <summary>
/// Integration tests exercising the full mixed tool invocation two-turn flow:
/// Turn 1: LLM calls both server and client tools → FICC emits ToolApprovalRequestContent
///         → stream converter unwraps to TOOL_CALL events → RUN_FINISHED(success)
/// Turn 2: Client sends continuation with client tool results → FICC invokes server tool
///         for real and uses cached client result → stream converter emits only server
///         TOOL_CALL_RESULT + final text
/// </summary>
public sealed class MixedToolInvocationIntegrationTest : IntegrationTestBase
{
    public MixedToolInvocationIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task FICC_ApprovalFlow_DirectTest()
    {
        // Test FICC approval processing directly without AG-UI
        var toolInvoked = false;
        var serverTool = AIFunctionFactory.Create(() => { toolInvoked = true; return "result"; }, "my_tool", "desc");

        var fakeLlm = new FakeChatClientWithCapture();
        // After approval processing, FICC should invoke the tool then call LLM
        fakeLlm.Enqueue(_ => EmitTextResponse("done"));

        var ficc = new ChatClientBuilder(fakeLlm)
            .UseFunctionInvocation()
            .Build();

        var fcc = new FunctionCallContent("call_1", "my_tool", new Dictionary<string, object?>());
        var request = new ToolApprovalRequestContent("req_1", fcc);
        var response = request.CreateResponse(approved: true);

        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "test"),
            new(ChatRole.Assistant, [request]),
            new(ChatRole.User, [response]),
        };

        var options = new ChatOptions { Tools = [serverTool] };
        var updates = new List<ChatResponseUpdate>();
        await foreach (var u in ficc.GetStreamingResponseAsync(messages, options))
        {
            updates.Add(u);
        }

        Assert.True(toolInvoked, "Tool should be invoked via approval flow");
    }

    [Fact]
    public async Task MixedInvocation_TwoTurnFlow_EmitsToolCallsThenServerResults()
    {
        const string testName = nameof(MixedInvocation_TwoTurnFlow_EmitsToolCallsThenServerResults);
        // Server tool: registered server-side (resolved via the approval-resume path on the
        // continuation). Client tool: declared by the client and auto-invoked client-side.
        var serverTool = AIFunctionFactory.Create(
            (string city) => $"{city}: 18C, rainy",
            "get_weather", "Gets the current weather for a given city.");

        // Record/replay: replay the captured real-LLM run if present, otherwise call Azure
        // OpenAI (gpt-5-mini) to capture a fresh mixed invocation. The capturing client wraps the
        // whole FunctionInvokingChatClient pipeline so the captured server-side updates (and the
        // events derived from them) match what goes over the wire.
        var serverCapture = new CapturingChatClient();
        var recording = LoadRecording(testName, s_jsonOptions);
        var hasRecording = recording.Count > 0 && recording[0].Count > 0;

        var factory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IChatClient>();
                services.AddSingleton<AITool>(serverTool);
                services.AddChatClient(sp =>
                {
                    if (hasRecording)
                    {
                        var fake = new FakeChatClientWithCapture();
                        foreach (var turn in recording)
                        {
                            var captured = turn;
                            fake.Enqueue(_ => ReplayUpdates(captured));
                        }

                        serverCapture.SetInner(fake);
                    }
                    else
                    {
                        var pipeline = new ChatClientBuilder(CreateAzureChatClient())
                            .UseFunctionInvocation(configure: f => f.TerminateOnUnknownCalls = true)
                            .Build(sp);
                        serverCapture.SetInner(pipeline);
                    }

                    return (IChatClient)serverCapture;
                });
            });
        });

        var httpClient = factory.CreateClient();
        var transport = new CapturingAGUITransport(new AGUIHttpTransport(httpClient, "/agui"));
        var aguiClient = new AGUIChatClient(new() { Transport = transport });

        var clientToolInvoked = false;
        var clientTool = AIFunctionFactory.Create(
            () => { clientToolInvoked = true; return "Tokyo, Japan"; },
            "get_user_location", "Gets the user's current city via GPS.");

        var clientMessages = new List<ChatMessage>
        {
            new(ChatRole.User,
                "Two things, please: (1) what city am I in right now, and (2) what's the weather in Paris? " +
                "Call get_user_location for #1 and get_weather for #2."),
        };
        var options = new ChatOptions { Tools = [clientTool] };

        var clientUpdates = await CollectUpdates(aguiClient, clientMessages, options);

        SaveRecording(testName, serverCapture, s_jsonOptions);

        // The client tool runs client-side in both record and replay; the server tool's execution
        // is captured in the baselines as a TOOL_CALL_RESULT event.
        Assert.True(clientToolInvoked, "Client tool should be auto-invoked by AGUIChatClient");

        await VerifyAllCaptures(transport, serverCapture, [clientMessages], [clientUpdates], testName);
    }

    private async Task VerifyAllCaptures(
        CapturingAGUITransport transport,
        CapturingChatClient server,
        List<List<ChatMessage>> clientMessages,
        List<List<ChatResponseUpdate>> clientUpdates,
        string testName)
    {
        var turns = new List<object>();
        for (int i = 0; i < transport.Turns.Count; i++)
        {
            var wire = transport.Turns[i];
            var srv = i < server.Calls.Count ? server.Calls[i] : null;

            List<BaseEvent>? serverDerivedEvents = null;
            if (srv != null)
            {
                serverDerivedEvents = new List<BaseEvent>();
                await foreach (var evt in ReplayUpdates(srv.Updates)
                    .AsAGUIEventStreamAsync(wire.Input.ToChatRequestContext(s_jsonOptions)).ConfigureAwait(false))
                {
                    serverDerivedEvents.Add(evt);
                }
            }

            turns.Add(new
            {
                client = new
                {
                    chatMessages = i < clientMessages.Count ? clientMessages[i] : null,
                    runAgentInput = wire.Input,
                    events = wire.Events,
                    chatResponseUpdates = i < clientUpdates.Count ? clientUpdates[i] : null
                },
                server = srv != null ? new
                {
                    runAgentInput = srv.RunAgentInput,
                    chatMessages = new { messages = srv.Messages, options = DescribeChatOptions(srv.Options) },
                    chatResponseUpdates = srv.Updates,
                    events = serverDerivedEvents
                } : null
            });
        }

        await VerifyCaptures(turns, testName, s_jsonOptions).ConfigureAwait(false);
    }

    private static IChatClient CreateAzureChatClient()
    {
        var endpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
            ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT is not set (recording requires Azure).");
        var deployment = Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT_NAME") ?? "gpt-5-mini";
        return new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential())
            .GetChatClient(deployment).AsIChatClient();
    }

#pragma warning disable CS1998 // Async method lacks 'await' operators
    private static async IAsyncEnumerable<ChatResponseUpdate> ReplayUpdates(List<ChatResponseUpdate> updates)
    {
        foreach (var update in updates)
        {
            yield return update;
        }
    }
#pragma warning restore CS1998

    private static readonly JsonSerializerOptions s_jsonOptions = CreateJsonOptions();

    private static JsonSerializerOptions CreateJsonOptions()
    {
        JsonSerializerOptions options = new(JsonSerializerDefaults.Web)
        {
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        options.TypeInfoResolverChain.Add(AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
        options.TypeInfoResolverChain.Add(AGUIJsonSerializerContext.Default);
        AGUI.Abstractions.AGUIJsonUtilities.RegisterInterruptContentTypes(options);
        options.Converters.Add(new ChatResponseUpdateCaptureConverter());

        return options;
    }

    [Fact]
    public async Task MixedInvocation_ServerOnlyToolCalls_NoApprovalFlow()
    {
        // When the LLM only calls server tools (not client tools), the normal
        // execution flow proceeds without the approval mechanism.
        var serverToolInvoked = false;
        string GetWeather(string city)
        {
            serverToolInvoked = true;
            return $"Weather in {city}: 18C, cloudy";
        }

        var serverTool = AIFunctionFactory.Create(GetWeather, "get_weather", "Gets the weather for a city");

        var fakeLlm = new FakeChatClientWithCapture();

        // Turn 1: LLM calls only the server tool
        fakeLlm.Enqueue(_ => EmitSingleToolCall("call_w1", "get_weather",
            new Dictionary<string, object?> { ["city"] = "London" }));
        // Turn 2: LLM produces final text after seeing server tool result
        fakeLlm.Enqueue(_ => EmitTextResponse("The weather in London is 18C and cloudy."));

        var factory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IChatClient>();
                services.AddSingleton<DelegatingStreamingChatClient>();
                services.AddSingleton<AITool>(serverTool);
                services.AddChatClient(sp => (IChatClient)fakeLlm)
                    .UseFunctionInvocation();
            });
        });

        var httpClient = factory.CreateClient();
        var transport = new AGUIHttpTransport(httpClient, "/agui");
        var aguiClient = new AGUIChatClient(new() { Transport = transport });

        // Client declares a client tool, but LLM only calls the server tool
        var clientTool = AIFunctionFactory.Create(() => "stub", "get_user_location", "Gets location");
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "What's the weather in London?")
        };
        var options = new ChatOptions { Tools = [clientTool] };

        var updates = await CollectUpdates(aguiClient, messages, options);

        // Server tool should have been invoked (FICC executed it in the tool loop)
        Assert.True(serverToolInvoked);

        // Final text should be present
        var text = ExtractText(updates);
        Assert.Contains("18C", text);

        // Should be a single run: RunStarted + text + RunFinished(success)
        var runFinished = updates.FirstOrDefault(u => u.RawRepresentation is RunFinishedEvent);
        Assert.NotNull(runFinished);
        Assert.Equal(ChatFinishReason.Stop, runFinished!.FinishReason);
    }

    [Fact]
    public async Task MixedInvocation_ClientOnlyToolCalls_TwoTurnFlow()
    {
        // When the LLM only calls client tools, the two-turn flow still works:
        // AGUIChatClient's FICC auto-invokes the client tool and sends the result
        // back to the server, which processes the continuation and calls the LLM.
        var clientToolInvoked = false;
        var fakeLlm = new FakeChatClientWithCapture();

        // Turn 1 (server): LLM calls only the client tool
        fakeLlm.Enqueue(_ => EmitSingleToolCall("call_loc1", "get_user_location",
            new Dictionary<string, object?>()));
        // Turn 2 (server): After continuation processing, LLM produces text
        fakeLlm.Enqueue(_ => EmitTextResponse("You are in Amsterdam!"));

        var factory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IChatClient>();
                services.AddSingleton<DelegatingStreamingChatClient>();
                services.AddChatClient(sp => (IChatClient)fakeLlm)
                    .UseFunctionInvocation();
            });
        });

        var httpClient = factory.CreateClient();
        var transport = new AGUIHttpTransport(httpClient, "/agui");
        var aguiClient = new AGUIChatClient(new() { Transport = transport });

        var clientTool = AIFunctionFactory.Create(
            () =>
            {
                clientToolInvoked = true;
                return "Amsterdam, Netherlands";
            },
            "get_user_location",
            "Gets location");

        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Where am I?")
        };
        var options = new ChatOptions { Tools = [clientTool] };

        // Single call: AGUIChatClient handles the full flow
        var updates = await CollectUpdates(aguiClient, messages, options);

        // Client tool was auto-invoked
        Assert.True(clientToolInvoked);

        // Final text
        var text = ExtractText(updates);
        Assert.Contains("Amsterdam", text);
    }

#pragma warning disable CS1998
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

#pragma warning restore CS1998

    /// <summary>
    /// A fake chat client that uses a queue of handlers.
    /// Each handler is called once per LLM turn.
    /// </summary>
    private sealed class FakeChatClientWithCapture : IChatClient
    {
        private readonly Queue<Func<IEnumerable<ChatMessage>, IAsyncEnumerable<ChatResponseUpdate>>> _handlers = new();

        internal void Enqueue(Func<IEnumerable<ChatMessage>, IAsyncEnumerable<ChatResponseUpdate>> handler)
        {
            _handlers.Enqueue(handler);
        }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            if (_handlers.Count == 0)
            {
                throw new InvalidOperationException("No handler enqueued on FakeChatClientWithCapture.");
            }

            var handler = _handlers.Dequeue();
            await foreach (var update in handler(messages).WithCancellation(cancellationToken).ConfigureAwait(false))
            {
                yield return update;
            }
        }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default)
        {
            throw new NotSupportedException();
        }

        public object? GetService(Type serviceType, object? serviceKey = null)
        {
            if (serviceType == typeof(IChatClient))
            {
                return this;
            }

            return null;
        }

        public void Dispose() { }
    }
}
