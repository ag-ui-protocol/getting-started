using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

public sealed class AGUIChatClientTest
{
    // https://github.com/microsoft/agent-framework/issues/4869
    // AGUIChatClient is a stateless client: it sends the full message history every turn.
    // It must NOT surface a ConversationId on returned updates, because MEAI agent wrappers
    // (e.g. AsAIAgent/ChatClientAgent) treat a returned ConversationId as a service-managed
    // session and then send only deltas on the next turn, truncating history against a
    // stateless AG-UI server. The AG-UI thread id is surfaced via AdditionalProperties instead.
    [Fact]
    public async Task GetStreamingResponse_DoesNotSurfaceConversationId()
    {
        var transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        var updates = new List<ChatResponseUpdate>();
        await foreach (var u in client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "hi") }, options))
        {
            updates.Add(u);
        }

        Assert.All(updates, u => Assert.Null(u.ConversationId));
    }

    // https://github.com/microsoft/agent-framework/issues/4869
    // The AG-UI thread id is still observable on returned updates via AdditionalProperties,
    // even though it is never promoted to ConversationId. A caller-supplied ConversationId is
    // honored as the thread id.
    [Fact]
    public async Task GetStreamingResponse_SurfacesThreadIdInAdditionalProperties()
    {
        var transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        var updates = new List<ChatResponseUpdate>();
        await foreach (var u in client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "hi") }, options))
        {
            updates.Add(u);
        }

        Assert.Contains(updates, u =>
            u.AdditionalProperties is not null
            && u.AdditionalProperties.TryGetValue("agui_thread_id", out string? threadId)
            && threadId == "t1");
    }

    // https://github.com/microsoft/agent-framework/issues/4869
    // When the caller reuses the same ChatOptions across turns and does not supply a
    // ConversationId, the client pins the generated AG-UI thread id onto the options so the
    // thread stays stable across turns — without ever advertising a ConversationId.
    [Fact]
    public async Task GetStreamingResponse_ReusedOptions_KeepsStableThreadIdWithoutConversationId()
    {
        var transport = new CapturingTransport(
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new TextMessageEndEvent { MessageId = "m1" });
        using var client = new AGUIChatClient(new() { Transport = transport });

        // Caller reuses the same ChatOptions instance across turns and supplies no ConversationId.
        var options = new ChatOptions();

        await DrainAsync(client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "turn one") }, options));

        var firstThreadId = transport.LastInput!.ThreadId;
        Assert.False(string.IsNullOrEmpty(firstThreadId));

        await DrainAsync(client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "turn two") }, options));

        // Same thread id is reused because it was pinned onto the reused options.
        Assert.Equal(firstThreadId, transport.LastInput!.ThreadId);
        Assert.Null(options.ConversationId);
        Assert.Equal(firstThreadId, options.AdditionalProperties?["agui_thread_id"]);
    }

    // https://github.com/microsoft/agent-framework/issues/4869
    // A fresh ChatOptions on each turn (no continuity hints) yields a different thread id per
    // turn — correctness is preserved because the full message history is sent every turn.
    [Fact]
    public async Task GetStreamingResponse_FreshOptionsPerTurn_GeneratesNewThreadId()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        await DrainAsync(client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "turn one") }, new ChatOptions()));
        var firstThreadId = transport.LastInput!.ThreadId;

        await DrainAsync(client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "turn two") }, new ChatOptions()));
        var secondThreadId = transport.LastInput!.ThreadId;

        Assert.NotEqual(firstThreadId, secondThreadId);
    }

    // https://github.com/microsoft/agent-framework/issues/4869
    // The full message history is sent to the transport on every turn (stateless protocol),
    // regardless of thread continuity.
    [Fact]
    public async Task GetStreamingResponse_SendsFullHistoryEveryTurn()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions();

        var history = new List<ChatMessage>
        {
            new(ChatRole.User, "first"),
            new(ChatRole.Assistant, "reply"),
            new(ChatRole.User, "second"),
        };

        await DrainAsync(client.GetStreamingResponseAsync(history, options));

        Assert.Equal(3, transport.LastInput!.Messages.Count);
    }

    [Fact]
    public async Task GetStreamingResponse_MultimodalContent_MapsAdditionalPropertiesToMetadata()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });
        var dataContent = new DataContent(new byte[] { 1, 2, 3, 4 }, "image/png")
        {
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["detail"] = "high"
            }
        };

        await DrainAsync(client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, [dataContent])],
            new ChatOptions()));

        var userMessage = Assert.IsType<AGUIUserMessage>(Assert.Single(transport.LastInput!.Messages));
        var image = Assert.IsType<AGUIImageInputContent>(Assert.Single(userMessage.Content));
        Assert.Equal("high", image.Metadata?.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task GetStreamingResponse_MultimodalContent_UsesConfiguredSerializerOptionsForMetadata()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new()
        {
            Transport = transport,
            JsonSerializerOptions = AGUIChatClientTestJsonSerializerContext.Default.Options
        });
        var dataContent = new DataContent(new byte[] { 1, 2, 3, 4 }, "image/png")
        {
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["provider"] = new CustomMetadata { QualityLevel = "high" }
            }
        };

        await DrainAsync(client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, [dataContent])],
            new ChatOptions()));

        var userMessage = Assert.IsType<AGUIUserMessage>(Assert.Single(transport.LastInput!.Messages));
        var image = Assert.IsType<AGUIImageInputContent>(Assert.Single(userMessage.Content));
        Assert.Equal("high", image.Metadata?.GetProperty("provider").GetProperty("quality_level").GetString());
    }

    [Fact]
    public async Task GetStreamingResponse_MultimodalContent_PreservesSerializedMetadataKeysWhenAddingFilename()
    {
        var transport = new CapturingTransport();
        var jsonSerializerOptions = new JsonSerializerOptions(AGUIChatClientTestJsonSerializerContext.Default.Options)
        {
            DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower
        };
        using var client = new AGUIChatClient(new()
        {
            Transport = transport,
            JsonSerializerOptions = jsonSerializerOptions
        });
        using var metadataDocument = JsonDocument.Parse("""{"providerHint":"high"}""");
        var dataContent = new DataContent(new byte[] { 1, 2, 3, 4 }, "image/png")
        {
            Name = "pixel.png",
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["metadata"] = metadataDocument.RootElement
            }
        };

        await DrainAsync(client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, [dataContent])],
            new ChatOptions()));

        var userMessage = Assert.IsType<AGUIUserMessage>(Assert.Single(transport.LastInput!.Messages));
        var image = Assert.IsType<AGUIImageInputContent>(Assert.Single(userMessage.Content));
        Assert.Equal("high", image.Metadata?.GetProperty("providerHint").GetString());
        Assert.False(image.Metadata?.TryGetProperty("provider_hint", out _) ?? true);
        Assert.Equal("pixel.png", image.Metadata?.GetProperty("filename").GetString());
    }

    // https://github.com/ag-ui-protocol/ag-ui/issues/2151
    // A caller-supplied RunAgentInput (via RawRepresentationFactory) must forward
    // Context and ForwardedProperties onto the request actually sent, alongside
    // the already-forwarded Messages/Tools/State/ParentRunId.
    [Fact]
    public async Task GetStreamingResponse_RawRepresentationFactory_ForwardsContextAndForwardedProperties()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        var forwardedProperties = JsonDocument.Parse("{\"tenant\":\"acme\"}").RootElement.Clone();

        var options = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                Context = new List<AGUIContext>
                {
                    new() { Description = "userId", Value = "u-123" },
                },
                ForwardedProperties = forwardedProperties,
            },
        };

        var history = new List<ChatMessage> { new(ChatRole.User, "Hello") };
        await DrainAsync(client.GetStreamingResponseAsync(history, options));

        var sent = transport.LastInput!;

        Assert.NotNull(sent.Context);
        var context = Assert.Single(sent.Context!);
        Assert.Equal("userId", context.Description);
        Assert.Equal("u-123", context.Value);

        Assert.NotNull(sent.ForwardedProperties);
        Assert.Equal(JsonValueKind.Object, sent.ForwardedProperties!.Value.ValueKind);
        Assert.Equal("acme", sent.ForwardedProperties!.Value.GetProperty("tenant").GetString());
    }

    // A caller-supplied Resume (via RawRepresentationFactory) must be forwarded too,
    // like the other RunAgentInput fields (#2177 review follow-up).
    [Fact]
    public async Task GetStreamingResponse_RawRepresentationFactory_ForwardsResume()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        var options = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                Resume = new List<AGUIResume>
                {
                    new() { InterruptId = "caller-interrupt", Status = ResumeStatus.Resolved },
                },
            },
        };

        var history = new List<ChatMessage> { new(ChatRole.User, "Hello") };
        await DrainAsync(client.GetStreamingResponseAsync(history, options));

        var resume = transport.LastInput!.Resume;
        Assert.NotNull(resume);
        var entry = Assert.Single(resume!);
        Assert.Equal("caller-interrupt", entry.InterruptId);
    }

    // A caller-supplied Resume takes precedence over the approval-response
    // translation (the callerSuppliedResume guard yields to it) (#2177).
    [Fact]
    public async Task GetStreamingResponse_CallerResume_TakesPrecedenceOverApprovalResponses()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        var options = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                Resume = new List<AGUIResume>
                {
                    new() { InterruptId = "caller-interrupt", Status = ResumeStatus.Resolved },
                },
            },
        };

        var toolCall = new FunctionCallContent("call-1", "someTool", new Dictionary<string, object?>());
        var history = new List<ChatMessage>
        {
            new(ChatRole.User, [new ToolApprovalResponseContent("req-approval", approved: true, toolCall)]),
        };

        await DrainAsync(client.GetStreamingResponseAsync(history, options));

        // The caller's Resume wins; the approval response is not translated over it.
        var resume = transport.LastInput!.Resume;
        Assert.NotNull(resume);
        var entry = Assert.Single(resume!);
        Assert.Equal("caller-interrupt", entry.InterruptId);
    }

    // A caller-supplied Resume takes precedence over the interrupt-response translation
    // too, matching the approval path. Previously the interrupt block appended
    // unconditionally, so a caller Resume dropped approvals but kept interrupts (#2177).
    [Fact]
    public async Task GetStreamingResponse_CallerResume_TakesPrecedenceOverInterruptResponses()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        var options = new ChatOptions
        {
            RawRepresentationFactory = _ => new RunAgentInput
            {
                Resume = new List<AGUIResume>
                {
                    new() { InterruptId = "caller-interrupt", Status = ResumeStatus.Resolved },
                },
            },
        };

        var history = new List<ChatMessage>
        {
            new(ChatRole.User, [new InterruptResponseContent("req-interrupt")]),
        };

        await DrainAsync(client.GetStreamingResponseAsync(history, options));

        // The caller's Resume wins; the interrupt response is not appended over it.
        var resume = transport.LastInput!.Resume;
        Assert.NotNull(resume);
        var entry = Assert.Single(resume!);
        Assert.Equal("caller-interrupt", entry.InterruptId);
    }

    // Metadata set on an InterruptResponseContent travels onto the resume entry the
    // client sends, alongside the payload — envelope data (signatures, routing keys)
    // as opposed to the answer itself.
    [Fact]
    public async Task GetStreamingResponse_InterruptResponseMetadata_ReachesTheResumeEntry()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        var history = new List<ChatMessage>
        {
            new(ChatRole.User,
            [
                new InterruptResponseContent("req-interrupt")
                {
                    Payload = JsonDocument.Parse("""{"approved":true}""").RootElement,
                    Metadata = JsonDocument.Parse(
                        """{"definitionId":"review-plan","key":"afterModel-review"}""").RootElement,
                },
            ]),
        };

        await DrainAsync(client.GetStreamingResponseAsync(history));

        var resume = transport.LastInput!.Resume;
        Assert.NotNull(resume);
        var entry = Assert.Single(resume!);
        Assert.Equal("req-interrupt", entry.InterruptId);
        Assert.True(entry.Payload!.Value.GetProperty("approved").GetBoolean());
        Assert.NotNull(entry.Metadata);
        Assert.Equal("review-plan", entry.Metadata!.Value.GetProperty("definitionId").GetString());
        Assert.Equal("afterModel-review", entry.Metadata!.Value.GetProperty("key").GetString());
    }

    // An InterruptResponseContent without metadata produces a resume entry without it.
    [Fact]
    public async Task GetStreamingResponse_InterruptResponseWithoutMetadata_OmitsIt()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        var history = new List<ChatMessage>
        {
            new(ChatRole.User, [new InterruptResponseContent("req-interrupt")]),
        };

        await DrainAsync(client.GetStreamingResponseAsync(history));

        var entry = Assert.Single(transport.LastInput!.Resume!);
        Assert.Null(entry.Metadata);
    }

    // https://github.com/microsoft/agent-framework/issues/5587
    [Fact]
    public async Task AGUIChatClient_ToolCallResultWithPlainTextContent_DoesNotParseAsJson()
    {
        var client = new AGUIChatClient(new() { Transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "thread-1", RunId = "run-1" },
            new ToolCallResultEvent
            {
                MessageId = "msg-1",
                ToolCallId = "call-1",
                Content = "Transferred.",
                Role = AGUIRoles.Tool
            },
            new RunFinishedEvent { ThreadId = "thread-1", RunId = "run-1" }) });

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, "start")],
            cancellationToken: CancellationToken.None).ConfigureAwait(false))
        {
            updates.Add(update);
        }

        var result = Assert.Single(updates.SelectMany(static update => update.Contents).OfType<FunctionResultContent>());
        Assert.Equal("call-1", result.CallId);
        Assert.Equal("Transferred.", result.Result);
    }

    // https://github.com/microsoft/agent-framework/issues/6511
    [Fact]
    public async Task AGUIChatClient_WorkflowToolCallResultWithPlainTextContent_DoesNotThrowJsonException()
    {
        var client = new AGUIChatClient(new() { Transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "thread-1", RunId = "run-1" },
            new ToolCallResultEvent
            {
                MessageId = "msg-1",
                ToolCallId = "call-1",
                Content = "Expense report ER-1 approved",
                Role = AGUIRoles.Tool
            },
            new RunFinishedEvent { ThreadId = "thread-1", RunId = "run-1" }) });

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, "approve ER-1")],
            cancellationToken: CancellationToken.None).ConfigureAwait(false))
        {
            updates.Add(update);
        }

        var result = Assert.Single(updates.SelectMany(static update => update.Contents).OfType<FunctionResultContent>());
        Assert.Equal("Expense report ER-1 approved", result.Result);
    }

    private static async Task DrainAsync(IAsyncEnumerable<ChatResponseUpdate> updates)
    {
        await foreach (var _ in updates.ConfigureAwait(false))
        {
        }
    }

    [Fact]
    public async Task ClientToolExecution_EmitsExecuteToolSpan_OnAGUIClientSource()
    {
        var activities = new List<Activity>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == AGUIClientInstrumentation.ActivitySourceName,
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = activity =>
            {
                lock (activities)
                {
                    activities.Add(activity);
                }
            },
        };
        ActivitySource.AddActivityListener(listener);

        // Turn 1 surfaces a call to the client tool; turn 2 (after the client executes it) finishes.
        var transport = new SequencedTransport(
            new BaseEvent[]
            {
                new ToolCallStartEvent { ToolCallId = "call-1", ToolCallName = "probe_location" },
                new ToolCallArgsEvent { ToolCallId = "call-1", Delta = "{}" },
                new ToolCallEndEvent { ToolCallId = "call-1" },
            },
            System.Array.Empty<BaseEvent>());

        var client = new AGUIChatClient(new AGUIChatClientOptions { Transport = transport });
        var tool = AIFunctionFactory.Create(() => "Amsterdam, NL", "probe_location", "Gets the user's location.");
        var options = new ChatOptions { Tools = [tool] };

        await foreach (var _ in client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, "Where am I?")], options).ConfigureAwait(false))
        {
        }

        List<Activity> snapshot;
        lock (activities)
        {
            snapshot = activities.ToList();
        }

        Assert.Contains(snapshot, a =>
            a.DisplayName == "execute_tool probe_location"
            && (string?)a.GetTagItem("gen_ai.tool.name") == "probe_location");
    }

    private sealed class SequencedTransport(params BaseEvent[][] turns) : IAGUITransport
    {
        private int _call;

        public async IAsyncEnumerable<BaseEvent> SendAsync(RunAgentInput input, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            var index = System.Math.Min(_call, turns.Length - 1);
            _call++;

            yield return new RunStartedEvent { ThreadId = input.ThreadId, RunId = input.RunId };

            foreach (var evt in turns[index])
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return evt;
            }

            yield return new RunFinishedEvent { ThreadId = input.ThreadId, RunId = input.RunId };

            await Task.CompletedTask.ConfigureAwait(false);
        }
    }

    private sealed class StaticTransport(params BaseEvent[] events) : IAGUITransport
    {
        public async IAsyncEnumerable<BaseEvent> SendAsync(RunAgentInput input, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            foreach (var evt in events)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return evt;
            }

            await Task.CompletedTask.ConfigureAwait(false);
        }
    }

    [Fact]
    public async Task GetStreamingResponse_SurfacesRunFinishedUsageAsUsageContent()
    {
        var transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent
            {
                ThreadId = "t1",
                RunId = "r1",
                Usage =
                [
                    new TokenUsage
                    {
                        Provider = "openai",
                        Model = "gpt-4o",
                        InputTokens = 11,
                        OutputTokens = 22,
                        TotalTokens = 33,
                        ReasoningTokens = 44,
                        CachedInputTokens = 55
                    }
                ]
            });
        using var client = new AGUIChatClient(new() { Transport = transport });

        var updates = new List<ChatResponseUpdate>();
        await foreach (var u in client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "hi") }))
        {
            updates.Add(u);
        }

        // ToChatResponse aggregates UsageContent across updates — this is how a caller of
        // the IChatClient abstraction actually reads usage.
        var usage = updates.ToChatResponse().Usage;
        Assert.NotNull(usage);
        Assert.Equal(11, usage.InputTokenCount);
        Assert.Equal(22, usage.OutputTokenCount);
        Assert.Equal(33, usage.TotalTokenCount);
        Assert.Equal(44, usage.ReasoningTokenCount);
        Assert.Equal(55, usage.CachedInputTokenCount);
    }

    [Fact]
    public async Task GetStreamingResponse_SurfacesRunErrorUsageAsUsageContent()
    {
        var errorEvent = new RunErrorEvent
        {
            Message = "failed",
            Code = "ERR",
            Usage =
            [
                new TokenUsage
                {
                    Provider = "openai",
                    Model = "gpt-4o",
                    InputTokens = 11,
                    OutputTokens = 22,
                    TotalTokens = 33,
                }
            ]
        };
        var transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            errorEvent);
        using var client = new AGUIChatClient(new() { Transport = transport });

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "hi") }))
        {
            updates.Add(update);
        }

        Assert.Collection(updates,
            update =>
            {
                Assert.IsType<RunStartedEvent>(update.RawRepresentation);
            },
            update =>
            {
                var error = Assert.IsType<ErrorContent>(Assert.Single(update.Contents));
                Assert.Equal("failed", error.Message);
                Assert.Equal("ERR", error.ErrorCode);
                Assert.Same(errorEvent, update.RawRepresentation);
            },
            update =>
            {
                var usage = Assert.IsType<UsageContent>(Assert.Single(update.Contents));
                Assert.Equal("gpt-4o", update.ModelId);
                Assert.Equal(11, usage.Details.InputTokenCount);
                Assert.Equal(22, usage.Details.OutputTokenCount);
                Assert.Equal(33, usage.Details.TotalTokenCount);
                Assert.Same(errorEvent, update.RawRepresentation);
            });

        var aggregated = updates.ToChatResponse().Usage;
        Assert.NotNull(aggregated);
        Assert.Equal(11, aggregated.InputTokenCount);
        Assert.Equal(22, aggregated.OutputTokenCount);
        Assert.Equal(33, aggregated.TotalTokenCount);
    }

    [Fact]
    public async Task GetStreamingResponse_UsageContentCarriesModelId()
    {
        var transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunFinishedEvent
            {
                ThreadId = "t1",
                RunId = "r1",
                Usage =
                [
                    new TokenUsage { Model = "gpt-4o", InputTokens = 10 },
                    new TokenUsage { Model = "gpt-4o-mini", InputTokens = 5 }
                ]
            });
        using var client = new AGUIChatClient(new() { Transport = transport });

        var updates = new List<ChatResponseUpdate>();
        await foreach (var u in client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "hi") }))
        {
            updates.Add(u);
        }

        // Per-model attribution must survive: one UsageContent per entry, each labelled.
        var usageUpdates = updates
            .Where(u => u.Contents.OfType<UsageContent>().Any())
            .ToList();

        Assert.Equal(2, usageUpdates.Count);
        Assert.Equal("gpt-4o", usageUpdates[0].ModelId);
        Assert.Equal(10, usageUpdates[0].Contents.OfType<UsageContent>().Single().Details.InputTokenCount);
        Assert.Equal("gpt-4o-mini", usageUpdates[1].ModelId);
        Assert.Equal(5, usageUpdates[1].Contents.OfType<UsageContent>().Single().Details.InputTokenCount);
    }

    [Fact]
    public async Task GetStreamingResponse_NoUsage_EmitsNoUsageContent()
    {
        var transport = new StaticTransport(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });
        using var client = new AGUIChatClient(new() { Transport = transport });

        var updates = new List<ChatResponseUpdate>();
        await foreach (var u in client.GetStreamingResponseAsync(
            new[] { new ChatMessage(ChatRole.User, "hi") }))
        {
            updates.Add(u);
        }

        Assert.DoesNotContain(updates, u => u.Contents.OfType<UsageContent>().Any());
        Assert.Null(updates.ToChatResponse().Usage);
    }

    private sealed class CapturingTransport(params BaseEvent[] middleEvents) : IAGUITransport
    {
        public RunAgentInput? LastInput { get; private set; }

        public async IAsyncEnumerable<BaseEvent> SendAsync(RunAgentInput input, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            LastInput = input;

            // Echo the thread/run ids back like a real stateless AG-UI server.
            yield return new RunStartedEvent { ThreadId = input.ThreadId, RunId = input.RunId };

            foreach (var evt in middleEvents)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return evt;
            }

            yield return new RunFinishedEvent { ThreadId = input.ThreadId, RunId = input.RunId };

            await Task.CompletedTask.ConfigureAwait(false);
        }
    }
}
