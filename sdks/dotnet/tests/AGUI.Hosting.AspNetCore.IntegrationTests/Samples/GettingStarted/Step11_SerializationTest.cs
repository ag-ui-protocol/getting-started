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
using Step11_Serialization.Client;
using Step11_Serialization.Server;
using VerifyXunit;
using Xunit;

namespace AGUI.Server.IntegrationTests.Samples.GettingStarted;

public sealed class Step11_SerializationTest : IntegrationTestBase<Step11_Serialization.Server.Program>
{
    public Step11_SerializationTest(WebApplicationFactory<Step11_Serialization.Server.Program> factory)
        : base(factory)
    {
    }

    [Fact]
    public async Task PostRun_EventsSerializeAndDeserializeRoundTrip()
    {
        var (aguiClient, transport, server) = CreateCapturingClient(turnCount: 2);

        var clientMessages = new List<List<ChatMessage>>();
        var clientUpdates = new List<List<ChatResponseUpdate>>();

        await Step11_Serialization.Client.SampleClient.RunAsync(
            aguiClient, TextWriter.Null, clientMessages, clientUpdates);

        var turn1Updates = clientUpdates[0];
        var turn1RunId = turn1Updates.First(u => u.ResponseId != null).ResponseId!;

        // Verify the events from both turns can round-trip through JSON serialization
        var allEvents = transport.Turns.SelectMany(t => t.Events).ToList();
        var serialized = JsonSerializer.Serialize(allEvents, s_jsonOptions);
        var deserialized = JsonSerializer.Deserialize<List<BaseEvent>>(serialized, s_jsonOptions);

        Assert.NotNull(deserialized);
        Assert.Equal(allEvents.Count, deserialized.Count);

        for (int i = 0; i < allEvents.Count; i++)
        {
            Assert.Equal(allEvents[i].GetType(), deserialized[i].GetType());
            Assert.Equal(allEvents[i].Type, deserialized[i].Type);
        }

        // Verify the round-trip serialization matches
        var reserialized = JsonSerializer.Serialize(deserialized, s_jsonOptions);
        Assert.Equal(serialized, reserialized);

        // Verify Turn 2's RunAgentInput has parentRunId set
        var turn2Input = transport.Turns[1].Input;
        Assert.Equal(turn1RunId, turn2Input.ParentRunId);

        // Verify Turn 2's RunAgentInput has only the new message (not full history)
        Assert.Single(turn2Input.Messages);

        // Verify the server received the full combined history on Turn 2
        var serverTurn2Messages = server.Calls[1].Messages;
        Assert.True(serverTurn2Messages.Count > 1, "Server should have received combined history on Turn 2");

        await VerifyAllCaptures(transport, server, clientMessages, clientUpdates, deserialized);
    }

    [Fact]
    public void AllEventTypes_SerializeAndDeserializeRoundTrip()
    {
        // Construct one instance of every event type to verify comprehensive serialization coverage
        var events = new List<BaseEvent>
        {
            new RunStartedEvent
            {
                ThreadId = "t1",
                RunId = "r1",
                ParentRunId = "r0",
                Input = new RunAgentInput
                {
                    ThreadId = "t1",
                    RunId = "r1",
                    Messages = [new AGUIUserMessage { Id = "msg1", Content = [new AGUITextInputContent { Text = "Hello" }] }]
                }
            },
            new StepStartedEvent { StepName = "step-1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello world" },
            new TextMessageEndEvent { MessageId = "m1" },
            new ToolCallStartEvent
            {
                ToolCallId = "call_1",
                ToolCallName = "get_weather",
                ParentMessageId = "m1"
            },
            new ToolCallArgsEvent
            {
                ToolCallId = "call_1",
                Delta = "{\"city\":\"Seattle\"}"
            },
            new ToolCallEndEvent { ToolCallId = "call_1" },
            new ToolCallResultEvent
            {
                ToolCallId = "call_1",
                Content = "{\"temp\":72,\"condition\":\"sunny\"}",
            },
            new StateSnapshotEvent
            {
                Snapshot = JsonSerializer.SerializeToElement(
                    new { counter = 1, items = new[] { "a", "b" } })
            },
            new StateDeltaEvent
            {
                Delta = JsonSerializer.SerializeToElement(new[] { new { op = "replace", path = "/counter", value = 2 } })
            },
            new MessagesSnapshotEvent
            {
                Messages =
                [
                    new AGUIUserMessage { Id = "msg1", Content = [new AGUITextInputContent { Text = "Hello" }] },
                    new AGUIAssistantMessage { Id = "msg2", Content = "Hello world" }
                ]
            },
            new ReasoningStartEvent(),
            new ReasoningMessageStartEvent { MessageId = "rm1" },
            new ReasoningMessageContentEvent { MessageId = "rm1", Delta = "Let me think..." },
            new ReasoningMessageChunkEvent { MessageId = "rm1", Delta = "...about this" },
            new ReasoningMessageEndEvent { MessageId = "rm1" },
            new ReasoningEncryptedValueEvent { Subtype = "message", EntityId = "e1", EncryptedValue = "encrypted-base64-data" },
            new ReasoningEndEvent(),
            new ActivitySnapshotEvent
            {
                MessageId = "act-1",
                ActivityType = "search",
                Content = JsonSerializer.SerializeToElement(new { title = "Searching...", description = "Searching for weather data", state = "in_progress" })
            },
            new ActivityDeltaEvent
            {
                MessageId = "act-1",
                ActivityType = "search",
                Patch = JsonSerializer.SerializeToElement(new[] { new { op = "replace", path = "/state", value = "completed" } })
            },
            new CustomEvent
            {
                Name = "my-custom-event",
                Value = JsonSerializer.SerializeToElement(new { key = "value" })
            },
            new StepFinishedEvent { StepName = "step-1" },
            new RunFinishedEvent
            {
                ThreadId = "t1",
                RunId = "r1",
                Outcome = new RunFinishedInterruptOutcome
                {
                    Interrupts =
                    [
                        new AGUIInterrupt
                        {
                            Id = "int-1",
                            Reason = InterruptReasons.ToolCall,
                            ToolCallId = "call_1",
                            Message = "Approval required for tool call: get_weather",
                        }
                    ]
                }
            },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunErrorEvent { Message = "Something went wrong", Code = "INTERNAL_ERROR" },
        };

        var serialized = JsonSerializer.Serialize(events, s_jsonOptions);
        var deserialized = JsonSerializer.Deserialize<List<BaseEvent>>(serialized, s_jsonOptions);

        Assert.NotNull(deserialized);
        Assert.Equal(events.Count, deserialized.Count);

        for (int i = 0; i < events.Count; i++)
        {
            Assert.Equal(events[i].GetType(), deserialized[i].GetType());
            Assert.Equal(events[i].Type, deserialized[i].Type);
        }

        // Verify exact round-trip fidelity
        var reserialized = JsonSerializer.Serialize(deserialized, s_jsonOptions);
        Assert.Equal(serialized, reserialized);
    }

    private (AGUIChatClient Client, CapturingAGUITransport Transport, CapturingChatClient Server) CreateCapturingClient(
        int turnCount = 1,
        [CallerMemberName] string testName = "")
    {
        var serverCapture = new CapturingChatClient();
        var recording = LoadRecording(testName, s_jsonOptions);
        var hasRecording = recording.Count > 0 && recording[0].Count > 0;

        var fakeClient = new FakeChatClient();
        if (hasRecording)
        {
            for (int i = 0; i < recording.Count; i++)
            {
                var callUpdates = recording[i];
                fakeClient.Enqueue(_ => ReplayUpdates(callUpdates));
            }
        }
        else
        {
            fakeClient.Enqueue(_ => EmitTextResponse("AG-UI events use a type discriminator for polymorphic serialization. "
                + "Each event has a 'type' field that identifies its concrete type, enabling "
                + "correct deserialization from JSON back to the proper .NET type."));
            if (turnCount > 1)
            {
                fakeClient.Enqueue(_ => EmitTextResponse("Event compaction reduces noise in an event stream. "
                    + "It merges TEXT_MESSAGE_CONTENT sequences into snapshots and "
                    + "collapses STATE_DELTA events into a final STATE_SNAPSHOT."));
            }
        }

        serverCapture.SetInner(fakeClient);

        var factory = Factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IChatClient>();
                services.AddSingleton<IChatClient>(serverCapture);
            });
        });

        var httpClient = factory.CreateClient();

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
        List<BaseEvent> roundTrippedEvents,
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
                } : null,
                roundTripped = new
                {
                    events = roundTrippedEvents
                }
            });
        }

        await VerifyCaptures(turns, testName, s_jsonOptions);
    }
}
