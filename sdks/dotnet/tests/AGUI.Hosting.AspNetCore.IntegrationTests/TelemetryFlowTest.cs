using System.Diagnostics;
using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using AGUI.Client;
using AGUI.Server;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

// Asserts the captured spans reflect the real execution flow — nesting (parent/child) and
// cross-run correlation — across the AG-UI client and server instrumentation composed with the
// Microsoft.Extensions.AI GenAI spans. Pipelines are composed directly (no HTTP) so the span tree
// is deterministic; all spans share the in-process trace started by the wrapping client activity.
public sealed class TelemetryFlowTest
{
    private static readonly System.Text.Json.JsonSerializerOptions Jso = AIJsonUtilities.DefaultOptions;

    [Fact]
    public async Task BackendTool_ServerExecuteToolNestsUnderAGUIRun()
    {
        using var capture = new SpanCapture();

        var weather = AIFunctionFactory.Create((string city) => $"sunny, 22C in {city}", "get_weather", "weather");
        IChatClient server = new FakeToolModel("get_weather").AsBuilder()
            .ConfigureOptions(o => (o.Tools ??= []).Add(weather))
            .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true)
            .UseOpenTelemetry()
            .Build();

        Activity root;
        using (root = capture.Root("scenario")!)
        {
            var ctx = new RunAgentInput { ThreadId = "t1", RunId = "r1" }.ToChatRequestContext(Jso);
            await Drain(server.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions).AsAGUIEventStreamAsync(ctx));
        }

        var spans = capture.Snapshot();
        var serverTool = Assert.Single(spans, a => a.DisplayName == "execute_tool get_weather");
        var aguiRun = Assert.Single(spans, a => a.DisplayName == "agui.run");
        var chatSpans = spans.Where(a => a.DisplayName == "chat" && a.Source.Name == MeaiSource).ToList();
        Assert.NotEmpty(chatSpans);

        // execute_tool and every GenAI chat nest under the AG-UI run, which is under the client root.
        Assert.True(SpanCapture.HasAncestor(spans, serverTool, aguiRun), "server execute_tool should nest under agui.run");
        Assert.All(chatSpans, chat => Assert.True(SpanCapture.HasAncestor(spans, chat, aguiRun), "GenAI chat should nest under agui.run"));
        Assert.True(SpanCapture.HasAncestor(spans, aguiRun, root), "agui.run should nest under the client activity");
        Assert.Equal(root.TraceId, serverTool.TraceId);
    }

    [Fact]
    public async Task ClientTool_ExecuteToolNestsUnderClientOrchestrateTools()
    {
        using var capture = new SpanCapture();

        IChatClient client = new AGUIChatClient(new AGUIChatClientOptions { Transport = new ToolThenFinishTransport("get_user_location") })
            .AsBuilder()
            .UseOpenTelemetry()
            .Build();
        var clientTool = AIFunctionFactory.Create(() => "Amsterdam, NL", "get_user_location", "Gets location.");

        using (capture.Root("scenario"))
        {
            await Drain2(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "where")], new ChatOptions { Tools = [clientTool] }));
        }

        var spans = capture.Snapshot();
        var clientTool1 = Assert.Single(spans, a => a.DisplayName == "execute_tool get_user_location");

        // The client tool runs locally: its span is on the AG-UI client source and nests under a
        // client-side orchestrate_tools.
        Assert.Equal(AGUIClientInstrumentation.ActivitySourceName, clientTool1.Source.Name);
        Assert.True(
            SpanCapture.HasAncestorWhere(spans, clientTool1, a => a.DisplayName == "orchestrate_tools" && a.Source.Name == AGUIClientInstrumentation.ActivitySourceName),
            "client execute_tool should nest under the client orchestrate_tools");
    }

    [Fact]
    public async Task HumanInTheLoop_TwoRunsCorrelate_InterruptThenSuccessWithParentRunId()
    {
        using var capture = new SpanCapture();

        IChatClient server = new ApprovalModel().AsBuilder().UseOpenTelemetry().Build();

        using (capture.Root("scenario"))
        {
            // Run 1 pauses for approval.
            var ctx1 = new RunAgentInput { ThreadId = "t1", RunId = "r1" }.ToChatRequestContext(Jso);
            await Drain(server.GetStreamingResponseAsync(ctx1.Messages, ctx1.ChatOptions).AsAGUIEventStreamAsync(ctx1));

            // Run 2 resumes, chained by parentRunId.
            var ctx2 = new RunAgentInput { ThreadId = "t1", RunId = "r2", ParentRunId = "r1" }.ToChatRequestContext(Jso);
            await Drain(ServerDone().AsAGUIEventStreamAsync(ctx2));
        }

        var spans = capture.Snapshot();
        var runs = spans.Where(a => a.DisplayName == "agui.run").ToList();
        Assert.Equal(2, runs.Count);
        Assert.Single(runs.Select(r => r.TraceId).Distinct());

        var interrupted = Assert.Single(runs, r => (string?)r.GetTagItem("agui.run.outcome") == "interrupt");
        var resumed = Assert.Single(runs, r => (string?)r.GetTagItem("agui.run.outcome") == "success");
        Assert.Null(interrupted.GetTagItem("agui.parent_run_id"));
        Assert.Equal("r1", resumed.GetTagItem("agui.parent_run_id"));
    }

    private const string MeaiSource = "Experimental.Microsoft.Extensions.AI";

    private static async IAsyncEnumerable<ChatResponseUpdate> ServerDone(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "Done.") { ModelId = "fake" };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async Task Drain(IAsyncEnumerable<BaseEvent> events)
    {
        await foreach (var _ in events.ConfigureAwait(false))
        {
        }
    }

    private static async Task Drain2(IAsyncEnumerable<ChatResponseUpdate> updates)
    {
        await foreach (var _ in updates.ConfigureAwait(false))
        {
        }
    }

    // Fake model: calls the named server tool; once a tool result is present, answers with text.
    private sealed class FakeToolModel(string toolName) : IChatClient
    {
        public void Dispose() { }

        public object? GetService(Type serviceType, object? serviceKey = null) =>
            serviceType == typeof(IChatClient) ? this : null;

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            if (messages.Any(m => m.Contents.Any(c => c is FunctionResultContent)))
            {
                yield return new ChatResponseUpdate(ChatRole.Assistant, "Done.") { ModelId = "fake" };
                yield break;
            }

            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                ModelId = "fake",
                FinishReason = ChatFinishReason.ToolCalls,
                Contents = [new FunctionCallContent("call_1", toolName, new Dictionary<string, object?>())],
            };
            await Task.CompletedTask.ConfigureAwait(false);
        }
    }

    // Fake model that raises a tool-approval request (the interrupt that pauses run 1).
    private sealed class ApprovalModel : IChatClient
    {
        public void Dispose() { }

        public object? GetService(Type serviceType, object? serviceKey = null) =>
            serviceType == typeof(IChatClient) ? this : null;

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            yield return new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                ModelId = "fake",
                Contents = [new ToolApprovalRequestContent("req_1", new FunctionCallContent("call_del", "delete_file", new Dictionary<string, object?>()))],
            };
            await Task.CompletedTask.ConfigureAwait(false);
        }
    }

    // Transport that surfaces one tool call (turn 1) then finishes (turn 2 continuation).
    private sealed class ToolThenFinishTransport(string toolName) : IAGUITransport
    {
        private int _call;

        public async IAsyncEnumerable<BaseEvent> SendAsync(RunAgentInput input, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            var first = _call++ == 0;
            yield return new RunStartedEvent { ThreadId = input.ThreadId, RunId = input.RunId };
            if (first)
            {
                yield return new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = toolName };
                yield return new ToolCallArgsEvent { ToolCallId = "c1", Delta = "{}" };
                yield return new ToolCallEndEvent { ToolCallId = "c1" };
            }

            yield return new RunFinishedEvent { ThreadId = input.ThreadId, RunId = input.RunId };
            await Task.CompletedTask.ConfigureAwait(false);
        }
    }

    private sealed class SpanCapture : IDisposable
    {
        private readonly ActivityListener _listener;
        private readonly ActivitySource _rootSource = new("Test.Telemetry.Flow");
        private readonly List<Activity> _activities = [];

        // The listener is process-global, and the AG-UI/MEAI sources are shared, so a
        // telemetry test running in parallel (e.g. RunTelemetryIntegrationTest) would
        // otherwise leak its spans into this capture. Every span of a scenario shares the
        // in-process trace started by Root(), so record only spans on an owned trace.
        private readonly HashSet<ActivityTraceId> _ownedTraces = [];

        public SpanCapture()
        {
            var sources = new HashSet<string>(StringComparer.Ordinal)
            {
                AGUIServerInstrumentation.ActivitySourceName,
                AGUIClientInstrumentation.ActivitySourceName,
                MeaiSource,
                "Test.Telemetry.Flow",
            };
            _listener = new ActivityListener
            {
                ShouldListenTo = source => sources.Contains(source.Name),
                Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                ActivityStopped = activity =>
                {
                    lock (_activities)
                    {
                        if (_ownedTraces.Contains(activity.TraceId))
                        {
                            _activities.Add(activity);
                        }
                    }
                },
            };
            ActivitySource.AddActivityListener(_listener);
        }

        public Activity? Root(string name)
        {
            var root = _rootSource.StartActivity(name);
            if (root is not null)
            {
                lock (_activities)
                {
                    _ownedTraces.Add(root.TraceId);
                }
            }

            return root;
        }

        public IReadOnlyList<Activity> Snapshot()
        {
            lock (_activities)
            {
                return _activities.ToArray();
            }
        }

        public static bool HasAncestor(IReadOnlyList<Activity> spans, Activity start, Activity target) =>
            HasAncestorWhere(spans, start, a => a.SpanId == target.SpanId);

        public static bool HasAncestorWhere(IReadOnlyList<Activity> spans, Activity start, Func<Activity, bool> predicate)
        {
            var bySpan = new Dictionary<ActivitySpanId, Activity>();
            foreach (var span in spans)
            {
                bySpan[span.SpanId] = span;
            }

            var current = start;
            for (var i = 0; i < 32 && current is not null; i++)
            {
                if (current.ParentSpanId == default || !bySpan.TryGetValue(current.ParentSpanId, out var parent))
                {
                    return false;
                }

                if (predicate(parent))
                {
                    return true;
                }

                current = parent;
            }

            return false;
        }

        public void Dispose()
        {
            _listener.Dispose();
            _rootSource.Dispose();
        }
    }
}
