using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class RunTelemetryTest
{
    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;
    private static readonly ActivitySource AmbientSource = new("Test.AGUI.Ambient");

    // Unique per test so assertions are robust against the global ActivityListener observing
    // agui.run spans produced by other test classes running in parallel.
    private readonly string _threadId = "thread-" + Guid.NewGuid().ToString("N");
    private readonly string _runId = "run-" + Guid.NewGuid().ToString("N");

    [Fact]
    public async Task SuccessfulRun_EmitsAGUIRunSpan_WithIdentityTagsAndSuccessOutcome()
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName);

        var events = await RunAsync(new RunAgentInput { ThreadId = _threadId, RunId = _runId },
            new ChatResponseUpdate(ChatRole.Assistant, "Hello"));

        var run = SingleRun(capture);
        Assert.Equal("agui.run", run.DisplayName);
        Assert.Equal(ActivityKind.Internal, run.Kind);
        Assert.Equal(_runId, run.GetTagItem("agui.run_id"));
        Assert.Equal("success", run.GetTagItem("agui.run.outcome"));
        Assert.Equal(events.Count, run.GetTagItem("agui.events.count"));
        Assert.Null(run.GetTagItem("agui.parent_run_id"));
        Assert.Equal(ActivityStatusCode.Unset, run.Status);
    }

    [Fact]
    public async Task InterruptingRun_OutcomeIsInterrupt()
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName);

        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new ToolApprovalRequestContent("req-1", new FunctionCallContent("call-1", "delete_file", new Dictionary<string, object?>()))],
        };

        await RunAsync(new RunAgentInput { ThreadId = _threadId, RunId = _runId }, update);

        Assert.Equal("interrupt", SingleRun(capture).GetTagItem("agui.run.outcome"));
    }

    [Fact]
    public async Task ContinuationRun_SetsParentRunIdTag()
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName);

        await RunAsync(
            new RunAgentInput { ThreadId = _threadId, RunId = _runId, ParentRunId = "parent-run" },
            new ChatResponseUpdate(ChatRole.Assistant, "Resumed"));

        Assert.Equal("parent-run", SingleRun(capture).GetTagItem("agui.parent_run_id"));
    }

    [Fact]
    public async Task Run_NestsUnderAmbientActivity_SharingTraceId()
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName, AmbientSource.Name);

        using var ambient = AmbientSource.StartActivity("client.operation");
        Assert.NotNull(ambient);

        await RunAsync(new RunAgentInput { ThreadId = _threadId, RunId = _runId },
            new ChatResponseUpdate(ChatRole.Assistant, "Hello"));

        var run = Assert.Single(capture.Snapshot(), a => a.DisplayName == "agui.run" && a.TraceId == ambient!.TraceId);
        Assert.Equal(ambient!.SpanId, run.ParentSpanId);
    }

    [Fact]
    public async Task TwoRuns_UnderOneAmbientActivity_ShareTraceId_AndChildCarriesParentRunId()
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName, AmbientSource.Name);

        using var ambient = AmbientSource.StartActivity("hitl.conversation");
        Assert.NotNull(ambient);

        // Run 1 pauses for approval.
        await RunAsync(new RunAgentInput { ThreadId = _threadId, RunId = _runId },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents = [new ToolApprovalRequestContent("req-1", new FunctionCallContent("call-1", "delete_file", new Dictionary<string, object?>()))],
            });

        // Run 2 resumes, chained to run 1 by parentRunId.
        await RunAsync(new RunAgentInput { ThreadId = _threadId, RunId = "run-2", ParentRunId = _runId },
            new ChatResponseUpdate(ChatRole.Assistant, "Done"));

        // Both runs correlate into the same trace as the client conversation.
        var runs = capture.Snapshot().Where(a => a.DisplayName == "agui.run" && a.TraceId == ambient!.TraceId).ToList();
        Assert.Equal(2, runs.Count);

        var first = runs.Single(r => (string?)r.GetTagItem("agui.run_id") == _runId);
        var second = runs.Single(r => (string?)r.GetTagItem("agui.run_id") == "run-2");
        Assert.Equal("interrupt", first.GetTagItem("agui.run.outcome"));
        Assert.Null(first.GetTagItem("agui.parent_run_id"));
        Assert.Equal(_runId, second.GetTagItem("agui.parent_run_id"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailingRun_SetsErrorStatusAndErrorType(bool yieldThread)
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName);

        var context = new RunAgentInput { ThreadId = _threadId, RunId = _runId }
            .ToChatRequestContext(SerializerOptions);

        var events = new List<BaseEvent>();
        await foreach (var evt in ThrowingUpdates(yieldThread).AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        var run = SingleRun(capture);
        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal("StreamingError", error.Code);
        Assert.Equal("An error occurred while streaming the agent response.", error.Message);
        var usage = Assert.Single(error.Usage!);
        Assert.Equal("test-model", usage.Model);
        Assert.Equal(7, usage.InputTokens);
        Assert.DoesNotContain(events, e => e is RunFinishedEvent);
        Assert.Equal("error", run.GetTagItem("agui.run.outcome"));
        Assert.Equal(typeof(InvalidOperationException).FullName, run.GetTagItem("error.type"));
        Assert.Equal(events.Count, run.GetTagItem("agui.events.count"));
        Assert.Equal(ActivityStatusCode.Error, run.Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ProviderOperationCanceledException_IsRecordedAsError(bool yieldThread)
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName);
        var context = new RunAgentInput { ThreadId = _threadId, RunId = _runId }
            .ToChatRequestContext(SerializerOptions);

        var events = new List<BaseEvent>();
        await foreach (var evt in ProviderCancellationUpdates(yieldThread)
            .AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        var run = SingleRun(capture);
        Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.DoesNotContain(events, e => e is RunFinishedEvent);
        Assert.Equal("error", run.GetTagItem("agui.run.outcome"));
        Assert.Equal(typeof(OperationCanceledException).FullName, run.GetTagItem("error.type"));
        Assert.Equal(events.Count, run.GetTagItem("agui.events.count"));
        Assert.Equal(ActivityStatusCode.Error, run.Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CallerCancellation_IsRecordedAsCanceledAndPropagates(bool yieldThread)
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName);
        using var cts = new CancellationTokenSource();
        var context = new RunAgentInput { ThreadId = _threadId, RunId = _runId }
            .ToChatRequestContext(SerializerOptions);
        var events = new List<BaseEvent>();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var evt in CallerCancellationUpdates(yieldThread, cts.Token)
                .AsAGUIEventStreamAsync(context, cts.Token).ConfigureAwait(false))
            {
                events.Add(evt);
                if (evt is TextMessageContentEvent)
                {
                    cts.Cancel();
                }
            }
        });

        var run = SingleRun(capture);
        Assert.DoesNotContain(events, e => e is RunErrorEvent or RunFinishedEvent);
        Assert.Equal("canceled", run.GetTagItem("agui.run.outcome"));
        Assert.Null(run.GetTagItem("error.type"));
        Assert.Equal(events.Count, run.GetTagItem("agui.events.count"));
        Assert.Equal(ActivityStatusCode.Unset, run.Status);
    }

    [Fact]
    public async Task CancellationAfterRunError_DoesNotOverwriteErrorOutcome()
    {
        using var capture = CaptureActivities(AGUIServerInstrumentation.ActivitySourceName);
        using var cts = new CancellationTokenSource();
        var context = new RunAgentInput { ThreadId = _threadId, RunId = _runId }
            .ToChatRequestContext(SerializerOptions);

        await foreach (var evt in ThrowingUpdates(yieldThread: false)
            .AsAGUIEventStreamAsync(context, cts.Token).ConfigureAwait(false))
        {
            if (evt is RunErrorEvent)
            {
                cts.Cancel();
            }
        }

        var run = SingleRun(capture);
        Assert.Equal("error", run.GetTagItem("agui.run.outcome"));
        Assert.Equal(typeof(InvalidOperationException).FullName, run.GetTagItem("error.type"));
        Assert.Equal(ActivityStatusCode.Error, run.Status);
    }

    [Fact]
    public async Task NoListener_DoesNotCreateAGUIRunActivity()
    {
        Activity? observed = null;
        var context = new RunAgentInput { ThreadId = _threadId, RunId = _runId }
            .ToChatRequestContext(SerializerOptions);

        await foreach (var _ in ToAsyncEnumerable(new ChatResponseUpdate(ChatRole.Assistant, "Hello"))
            .AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            observed ??= Activity.Current;
        }

        // With no listener of this test's own, the run is never wrapped in an agui.run span.
        Assert.True(observed is null || observed.DisplayName != "agui.run");
    }

    private Activity SingleRun(ActivityCapture capture) =>
        Assert.Single(capture.Snapshot(), a => (string?)a.GetTagItem("agui.thread_id") == _threadId);

    private static async Task<List<BaseEvent>> RunAsync(RunAgentInput input, params ChatResponseUpdate[] updates)
    {
        var context = input.ToChatRequestContext(SerializerOptions);
        var events = new List<BaseEvent>();
        await foreach (var evt in ToAsyncEnumerable(updates).AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        return events;
    }

    private static ActivityCapture CaptureActivities(params string[] sourceNames)
    {
        var capture = new ActivityCapture(sourceNames);
        ActivitySource.AddActivityListener(capture.Listener);
        return capture;
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> ToAsyncEnumerable(params ChatResponseUpdate[] items)
    {
        foreach (var item in items)
        {
            yield return item;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> ThrowingUpdates(
        bool yieldThread,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "partial");
        yield return new ChatResponseUpdate
        {
            ModelId = "test-model",
            Contents = [new UsageContent(new UsageDetails { InputTokenCount = 7 })]
        };
        if (yieldThread)
        {
            await Task.Yield();
        }

        throw new InvalidOperationException("boom");
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> ProviderCancellationUpdates(bool yieldThread)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "partial");
        if (yieldThread)
        {
            await Task.Yield();
        }

        throw new OperationCanceledException("provider timeout");
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> CallerCancellationUpdates(
        bool yieldThread,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "partial");
        if (yieldThread)
        {
            await Task.Yield();
        }

        yield return new ChatResponseUpdate(ChatRole.Assistant, "provider ignored cancellation");
    }

    private sealed class ActivityCapture : IDisposable
    {
        public ActivityCapture(string[] sourceNames)
        {
            var set = new HashSet<string>(sourceNames, StringComparer.Ordinal);
            Listener = new ActivityListener
            {
                ShouldListenTo = source => set.Contains(source.Name),
                Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                ActivityStopped = activity =>
                {
                    lock (Activities)
                    {
                        Activities.Add(activity);
                    }
                },
            };
        }

        public ActivityListener Listener { get; }

        public List<Activity> Activities { get; } = [];

        public IReadOnlyList<Activity> Snapshot()
        {
            lock (Activities)
            {
                return Activities.ToArray();
            }
        }

        public void Dispose() => Listener.Dispose();
    }
}
