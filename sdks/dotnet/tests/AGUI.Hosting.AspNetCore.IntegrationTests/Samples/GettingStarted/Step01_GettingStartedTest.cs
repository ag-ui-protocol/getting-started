using AGUI.Abstractions;
using AGUI.Client;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Step01_GettingStarted.Client;
using Step01_GettingStarted.Server;
using System.Runtime.CompilerServices;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text.Json.Serialization;
using VerifyXunit;
using Xunit;

namespace AGUI.Server.IntegrationTests.Samples.GettingStarted;

public sealed class Step01_GettingStartedTest : IntegrationTestBase<Step01_GettingStarted.Server.Program>
{
    public Step01_GettingStartedTest(WebApplicationFactory<Step01_GettingStarted.Server.Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task PostRun_MultiTurn_SynthesizesAssistantMessages()
    {
        var (aguiClient, transport, server) = CreateCapturingClient(turnCount: 2);

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
                // Replay mode: use FakeChatClient with recorded responses
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
                if (hasRecording)
                {
                    // Replay mode: wrap FakeChatClient
                    services.AddSingleton<IChatClient>(sp =>
                    {
                        var fake = sp.GetRequiredService<FakeChatClient>();
                        serverCapture.SetInner(fake);
                        return serverCapture;
                    });
                }
                else
                {
                    // Record mode: wrap whatever IChatClient the app registered (e.g. Azure OpenAI)
                    var descriptor = services.FirstOrDefault(d => d.ServiceType == typeof(IChatClient));
                    if (descriptor != null)
                    {
                        services.Remove(descriptor);
                    }

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

        // Chain AIJsonUtilities first for MEAI types (ChatMessage, ChatResponseUpdate, etc.)
        // then AGUIJsonSerializerContext for AG-UI types (RunAgentInput, BaseEvent, etc.)
        options.TypeInfoResolverChain.Add(AIJsonUtilities.DefaultOptions.TypeInfoResolver!);
        options.TypeInfoResolverChain.Add(AGUIJsonSerializerContext.Default);
        AGUI.Abstractions.AGUIJsonUtilities.RegisterInterruptContentTypes(options);
        options.Converters.Add(new ChatResponseUpdateCaptureConverter());

        return options;
    }

    // Captures all 8 data points across the 4 MEAI↔AG-UI boundaries per turn,
    // structured as { client: { ... }, server: { ... } }:
    //
    // Client side:
    //   chatMessages       → MEAI messages passed to AGUIChatClient
    //   runAgentInput      → AG-UI request serialized by client transport
    //   events             → AG-UI events deserialized by client transport
    //   chatResponseUpdates → MEAI updates returned from AGUIChatClient
    //
    // Server side:
    //   runAgentInput       → AG-UI request deserialized by server endpoint
    //   chatMessages        → MEAI messages passed to LLM (after AG-UI→MEAI conversion)
    //   chatResponseUpdates → MEAI updates returned by LLM
    //   events              → AG-UI events serialized by server endpoint (same as client.events over wire)
    private async Task VerifyAllCaptures(
        CapturingAGUITransport transport,
        CapturingChatClient server,
        List<List<ChatMessage>> clientMessages,
        List<List<ChatResponseUpdate>> clientUpdates,
        [CallerMemberName] string testName = "")
    {
        // Save the server responses as a recording for future replay
        SaveRecording(testName, server, s_jsonOptions);

        var turns = new List<object>();
        for (int i = 0; i < transport.Turns.Count; i++)
        {
            var wire = transport.Turns[i];
            var srv = i < server.Calls.Count ? server.Calls[i] : null;

            // Derive the AG-UI events the server would emit from its captured ChatResponseUpdates
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
