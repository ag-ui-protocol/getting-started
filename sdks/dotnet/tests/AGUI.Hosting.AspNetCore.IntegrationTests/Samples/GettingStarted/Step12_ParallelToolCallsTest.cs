using AGUI.Abstractions;
using AGUI.Client;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Step12_ParallelToolCalls.Client;
using Step12_ParallelToolCalls.Server;
using System.Runtime.CompilerServices;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Xunit;

namespace AGUI.Server.IntegrationTests.Samples.GettingStarted;

/// <summary>
/// Parallel backend tool calls: a single user prompt elicits two independent server-side tool
/// calls (get_weather + get_current_time) in one assistant turn. FunctionInvokingChatClient
/// executes both and the stream converter emits both TOOL_CALL_RESULT events.
///
/// Beyond the standard layer-2 baseline capture, this test validates the parallel-tool-result
/// conversion contract in BOTH directions:
///   * Outbound (<see cref="AGUIChatMessageExtensions.AsAGUIMessages(IEnumerable{ChatMessage}, JsonSerializerOptions)"/>): a tool
///     <see cref="ChatMessage"/> carrying multiple <see cref="FunctionResultContent"/>s must
///     emit one <see cref="AGUIToolMessage"/> per result, each keyed on its call id.
///   * Inbound (<see cref="AGUIChatMessageExtensions.AsChatMessages"/>): consecutive AG-UI tool
///     messages map back to tool <see cref="ChatMessage"/>s carrying one result each, which is
///     the OpenAI-valid shape (one tool message per tool_call_id).
/// </summary>
public sealed class Step12_ParallelToolCallsTest : IntegrationTestBase<Step12_ParallelToolCalls.Server.Program>
{
    public Step12_ParallelToolCallsTest(WebApplicationFactory<Step12_ParallelToolCalls.Server.Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task PostRun_WithParallelToolCalls_InvokesBothToolsAndStreamsResults()
    {
        var (aguiClient, transport, server) = CreateCapturingClient(turnCount: 1);

        var clientMessages = new List<List<ChatMessage>>();
        var clientUpdates = new List<List<ChatResponseUpdate>>();

        await SampleClient.RunAsync(aguiClient, TextWriter.Null, clientMessages, clientUpdates);

        // Save the recording immediately so a record-mode run captures the fixture even if the
        // roundtrip assertions below fail (they fail before the AsAGUIMessages fix is applied).
        SaveRecording(nameof(PostRun_WithParallelToolCalls_InvokesBothToolsAndStreamsResults), server, s_jsonOptions);

        // The single server turn must carry two parallel tool calls and two tool results.
        Assert.NotEmpty(server.Calls);
        var serverUpdates = server.Calls[0].Updates;
        var serverResponse = serverUpdates.ToChatResponse();

        var functionCalls = serverResponse.Messages
            .SelectMany(m => m.Contents.OfType<FunctionCallContent>())
            .ToList();
        var functionResults = serverResponse.Messages
            .SelectMany(m => m.Contents.OfType<FunctionResultContent>())
            .ToList();

        Assert.Equal(2, functionCalls.Count);
        Assert.Equal(2, functionResults.Count);
        Assert.Contains(functionCalls, c => c.Name == "get_weather");
        Assert.Contains(functionCalls, c => c.Name == "get_current_time");

        var resultCallIds = functionResults.Select(r => r.CallId).ToList();
        Assert.Equal(2, resultCallIds.Distinct().Count());

        // --- Outbound roundtrip: ChatMessage(Tool) history -> AG-UI messages ---
        // Reconstruct the tool-result history exactly as MEAI produces it and convert it
        // back to AG-UI. Both results must survive as distinct AGUIToolMessages keyed on
        // their call ids (the response side keys TOOL_CALL_RESULT.messageId on the call id too).
        var toolMessages = serverResponse.Messages.Where(m => m.Role == ChatRole.Tool).ToList();
        var aguiToolMessages = toolMessages.AsAGUIMessages(s_jsonOptions).OfType<AGUIToolMessage>().ToList();

        Assert.Equal(2, aguiToolMessages.Count);
        Assert.Equal(
            functionResults.Select(r => r.CallId).OrderBy(id => id, StringComparer.Ordinal),
            aguiToolMessages.Select(m => m.ToolCallId).OrderBy(id => id, StringComparer.Ordinal));
        // Id must equal the tool call id (distinct per result), never a shared message id.
        Assert.Equal(
            aguiToolMessages.Select(m => m.ToolCallId).OrderBy(id => id, StringComparer.Ordinal),
            aguiToolMessages.Select(m => m.Id).OrderBy(id => id, StringComparer.Ordinal));
        Assert.Equal(2, aguiToolMessages.Select(m => m.Id).Distinct().Count());

        // --- Inbound roundtrip: AG-UI tool messages -> ChatMessage(Tool) ---
        // Each AG-UI tool message maps to one tool ChatMessage with one FunctionResultContent.
        // The OpenAI provider expects one tool message per tool_call_id, so the 1:1 shape is
        // exactly what the model accepts (proven by the recorded real-LLM run succeeding).
        var roundTrippedChatMessages = aguiToolMessages.Cast<AGUIMessage>().AsChatMessages().ToList();
        Assert.Equal(2, roundTrippedChatMessages.Count);
        Assert.All(roundTrippedChatMessages, m =>
        {
            Assert.Equal(ChatRole.Tool, m.Role);
            Assert.Single(m.Contents.OfType<FunctionResultContent>());
        });
        Assert.Equal(
            functionResults.Select(r => r.CallId).OrderBy(id => id, StringComparer.Ordinal),
            roundTrippedChatMessages
                .SelectMany(m => m.Contents.OfType<FunctionResultContent>())
                .Select(r => r.CallId)
                .OrderBy(id => id, StringComparer.Ordinal));

        await VerifyAllCaptures(transport, server, clientMessages, clientUpdates);
    }

    private (AGUIChatClient Client, CapturingAGUITransport Transport, CapturingChatClient Server) CreateCapturingClient(
        int turnCount = 1,
        [CallerMemberName] string testName = "")
    {
        var serverCapture = new CapturingChatClient();
        var recording = LoadRecording(testName, s_jsonOptions);
        var hasRecording = recording.Count > 0 && recording[0].Count > 0;

        var httpClient = Factory.WithWebHostBuilder(builder =>
        {
            if (hasRecording)
            {
                // Replay mode: the recording holds the production pipeline's output (the two
                // tool calls, the two tool results, and the final text). Replay it through a
                // FakeChatClient that stands in for the whole server pipeline.
                builder.ConfigureServices(services =>
                {
                    var chatClient = new FakeChatClient();
                    for (int i = 0; i < turnCount; i++)
                    {
                        if (i < recording.Count)
                        {
                            var turnUpdates = recording[i];
                            chatClient.Enqueue(_ => ReplayUpdates(turnUpdates));
                        }
                    }

                    services.AddSingleton(chatClient);
                });
            }

            builder.ConfigureTestServices(services =>
            {
                var descriptor = services.FirstOrDefault(d => d.ServiceType == typeof(IChatClient));
                if (descriptor != null)
                {
                    services.Remove(descriptor);
                }

                if (hasRecording)
                {
                    services.AddSingleton<IChatClient>(sp =>
                    {
                        var fake = sp.GetRequiredService<FakeChatClient>();
                        serverCapture.SetInner(fake);
                        return serverCapture;
                    });
                }
                else
                {
                    // Record mode: wrap the app's real pipeline (Azure OpenAI + tools +
                    // UseFunctionInvocation) so a real LLM run is captured for replay.
                    services.AddSingleton<IChatClient>(sp =>
                    {
                        var inner = (IChatClient)descriptor!.ImplementationFactory!(sp);
                        serverCapture.SetInner(inner);
                        return serverCapture;
                    });
                }
            });
        }).CreateClient();

        var transport = new AGUIHttpTransport(httpClient, "/");
        var transportCapture = new CapturingAGUITransport(transport);
        var aguiClient = new AGUIChatClient(new() { Transport = transportCapture });

        return (aguiClient, transportCapture, serverCapture);
    }

#pragma warning disable CS1998 // Async method lacks 'await' operators
    private static async IAsyncEnumerable<ChatResponseUpdate> ReplayUpdates(
        List<ChatResponseUpdate> updates)
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

    private async Task VerifyAllCaptures(
        CapturingAGUITransport transport,
        CapturingChatClient server,
        List<List<ChatMessage>> clientMessages,
        List<List<ChatResponseUpdate>> clientUpdates,
        [CallerMemberName] string testName = "")
    {
        SaveRecording(testName, server, s_jsonOptions);

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
                    .AsAGUIEventStreamAsync(wire.Input.ToChatRequestContext(s_jsonOptions)))
                {
                    serverDerivedEvents.Add(evt);
                }
            }

            turns.Add(new
            {
                client = new
                {
                    chatMessages = i < clientMessages.Count
                        ? clientMessages[i]
                        : null,
                    runAgentInput = wire.Input,
                    events = wire.Events,
                    chatResponseUpdates = i < clientUpdates.Count
                        ? clientUpdates[i]
                        : null
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

        await VerifyCaptures(turns, testName, s_jsonOptions);
    }
}
