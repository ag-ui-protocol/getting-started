using System.Diagnostics;
using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.IntegrationTests;

public sealed class RunTelemetryIntegrationTest : IntegrationTestBase
{
    public RunTelemetryIntegrationTest(WebApplicationFactory<Program> factory)
        : base(factory)
    {
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_EmitsAGUIRunSpan_WithSuccessOutcome(TransportFormat format)
    {
        var threadId = "thread-" + Guid.NewGuid().ToString("N");
        using var capture = new RunSpanCapture(threadId);

        var client = CreateClient((messages, options, ct) => EmitTextResponse("Hello there", ct), format);
        await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Hi")], PinThread(threadId));

        var run = capture.Single();
        Assert.Equal("agui.run", run.DisplayName);
        Assert.Equal(threadId, run.GetTagItem("agui.thread_id"));
        Assert.NotNull(run.GetTagItem("agui.run_id"));
        Assert.Equal("success", run.GetTagItem("agui.run.outcome"));
        Assert.NotNull(run.GetTagItem("agui.events.count"));
    }

    [Theory]
    [InlineData(TransportFormat.Json)]
    [InlineData(TransportFormat.Protobuf)]
    public async Task PostRun_ApprovalInterrupt_EmitsInterruptOutcome(TransportFormat format)
    {
        var threadId = "thread-" + Guid.NewGuid().ToString("N");
        using var capture = new RunSpanCapture(threadId);

        var client = CreateClient((messages, options, ct) => EmitApprovalRequest(ct), format);
        await CollectUpdates(client, [new ChatMessage(ChatRole.User, "Delete it")], PinThread(threadId));

        var run = capture.Single();
        Assert.Equal("interrupt", run.GetTagItem("agui.run.outcome"));
    }

    private static ChatOptions PinThread(string threadId) =>
        new() { RawRepresentationFactory = _ => new RunAgentInput { ThreadId = threadId } };

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitApprovalRequest(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        yield return new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new ToolApprovalRequestContent("req-1", new FunctionCallContent("call-1", "delete_file", new Dictionary<string, object?>()))],
        };
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private sealed class RunSpanCapture : IDisposable
    {
        private readonly string _threadId;
        private readonly List<Activity> _activities = [];
        private readonly ActivityListener _listener;

        public RunSpanCapture(string threadId)
        {
            _threadId = threadId;
            _listener = new ActivityListener
            {
                ShouldListenTo = source => source.Name == AGUIServerInstrumentation.ActivitySourceName,
                Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                ActivityStopped = activity =>
                {
                    lock (_activities)
                    {
                        _activities.Add(activity);
                    }
                },
            };
            ActivitySource.AddActivityListener(_listener);
        }

        public Activity Single()
        {
            lock (_activities)
            {
                return Assert.Single(_activities, a => (string?)a.GetTagItem("agui.thread_id") == _threadId);
            }
        }

        public void Dispose() => _listener.Dispose();
    }
}
