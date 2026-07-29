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

        Assert.Equal(JsonValueKind.Object, sent.ForwardedProperties.ValueKind);
        Assert.Equal("acme", sent.ForwardedProperties.GetProperty("tenant").GetString());
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
