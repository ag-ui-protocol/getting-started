using System.Runtime.CompilerServices;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Step08_MultimodalMessages.Client;
using Step08_MultimodalMessages.Server;
using VerifyXunit;
using Xunit;

namespace AGUI.Server.IntegrationTests.Samples.GettingStarted;

public sealed class Step08_MultimodalMessagesTest : IntegrationTestBase<Step08_MultimodalMessages.Server.Program>
{
    public Step08_MultimodalMessagesTest(WebApplicationFactory<Step08_MultimodalMessages.Server.Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task PostRun_WithImageUrl_DescribesImage()
    {
        var (aguiClient, transport, server) = CreateCapturingClient();

        var clientMessages = new List<List<ChatMessage>>();
        var clientUpdates = new List<List<ChatResponseUpdate>>();

        var imagePath = Path.Combine(
            AttributeReader.GetProjectDirectory(),
            "Samples",
            "GettingStarted",
            "ag-ui-logo.png");
        var imageBytes = await File.ReadAllBytesAsync(imagePath);

        await Step08_MultimodalMessages.Client.SampleClient.RunAsync(
            aguiClient, TextWriter.Null, imageBytes, clientMessages, clientUpdates);

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
                builder.ConfigureServices(services =>
                {
                    var fakeClient = new FakeChatClient();
                    foreach (var turnUpdates in recording)
                    {
                        var captured = turnUpdates;
                        fakeClient.Enqueue(_ => ReplayUpdates(captured));
                    }

                    services.AddSingleton(fakeClient);
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
                        serverCapture.SetInner(sp.GetRequiredService<FakeChatClient>());
                        return serverCapture;
                    });
                }
                else
                {
                    // Record mode: wrap the app's real Azure OpenAI pipeline so a real LLM
                    // run is captured for deterministic replay.
                    services.AddSingleton<IChatClient>(sp =>
                    {
                        serverCapture.SetInner((IChatClient)descriptor!.ImplementationFactory!(sp));
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
