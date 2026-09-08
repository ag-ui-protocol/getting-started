using AGUI.Abstractions;
using AGUI.Client;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Step02_BackendTools.Client;
using Step02_BackendTools.Server;
using System.Runtime.CompilerServices;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text.Json.Serialization;
using VerifyXunit;
using Xunit;

namespace AGUI.Server.IntegrationTests.Samples.GettingStarted;

public sealed class Step02_BackendToolsTest : IntegrationTestBase<Step02_BackendTools.Server.Program>
{
    public Step02_BackendToolsTest(WebApplicationFactory<Step02_BackendTools.Server.Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task PostRun_WithBackendToolCall_InvokesToolAndStreamsResult()
    {
        var (aguiClient, transport, server) = CreateCapturingClient(turnCount: 1);

        var clientMessages = new List<List<ChatMessage>>();
        var clientUpdates = new List<List<ChatResponseUpdate>>();

        await SampleClient.RunAsync(aguiClient, TextWriter.Null, clientMessages, clientUpdates);

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
                // Replay mode: the recording holds the production pipeline's output (the tool
                // call, the tool result, and the final text). Replay it through a FakeChatClient
                // that stands in for the whole server pipeline.
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
