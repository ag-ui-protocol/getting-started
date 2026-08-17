using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Server;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.A2UI.UnitTests;

/// <summary>
/// Behavior tests for the <see cref="A2UIChatClient"/> decorator. Focused on the recovery
/// streaming path where the render sub-agent fails mid-stream: the adapter must still balance the
/// forwarded render_a2ui call with a tool result (using the call id learned from the streamed
/// fragments, since the typed FunctionCallContent never arrives on a mid-stream failure).
/// </summary>
public sealed class A2UIChatClientTest
{
    private const string RenderCallId = "call_render_stream";

    [Fact]
    public async Task MidStreamSubagentFailure_StillEmitsBalancingRenderResultAsync()
    {
        // Arrange: a planner that calls generate_a2ui once, and a render sub-agent that streams one
        // argument fragment (carrying the render call id) and then throws a recoverable error before
        // the typed FunctionCallContent can coalesce.
        var planner = new ScriptedPlannerClient();
        var subagent = new MidStreamThrowingSubagentClient();
        var options = new A2UIChatClientOptions
        {
            // Injection is off unless the run forwards injectA2UITool or the backend opts in. This
            // test drives the decorator directly with no RunAgentInput, so it opts in.
            InjectA2UITool = true,
            StreamingToolCallArgumentExtractor = u => u.RawRepresentation as IEnumerable<AGUIToolCallArgumentFragment>,
        };
        var client = new A2UIChatClient(planner, subagent, options);

        // Act
        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "make a card")]))
        {
            updates.Add(update);
        }

        // Assert: the forwarded render_a2ui call is balanced by a tool result keyed on the id that
        // arrived only via the streamed fragment (Finding 2). Without the fragment-derived id the
        // result would be dropped, leaving an unbalanced tool call in the persisted history.
        // Each of the (retried) attempts streams a fragment then fails, so each emits its own
        // balancing result under the fragment-derived id — at least one must be present.
        Assert.Contains(
            updates.SelectMany(u => u.Contents).OfType<FunctionResultContent>(),
            r => r.CallId == RenderCallId);

        // And the sub-agent failing every attempt yields a structured recovery-exhausted envelope
        // as the generate_a2ui result (the conversation stays usable rather than throwing).
        var generateResult = updates
            .SelectMany(u => u.Contents)
            .OfType<FunctionResultContent>()
            .Single(r => r.CallId == ScriptedPlannerClient.GenerateCallId);
        var envelope = Assert.IsType<JsonElement>(generateResult.Result);
        Assert.Contains("a2ui_recovery_exhausted", envelope.GetRawText());
    }

    [Fact]
    public async Task RoundTwoHistory_PreservesDeveloperToolCallAndResultAsync()
    {
        // A planner whose first turn both calls a developer tool (get_weather, resolved by the
        // inner function-invocation layer) and then calls generate_a2ui. The decorator loops for
        // a second round to let the planner consume the generation result; the history it hands
        // back must still carry the get_weather call and its result, or the round-2 planner is
        // stranded without the tool context it just produced.
        var planner = new DevToolThenGenerateClient();
        var subagent = new MidStreamThrowingSubagentClient();
        var options = new A2UIChatClientOptions
        {
            InjectA2UITool = true,
            StreamingToolCallArgumentExtractor = u => u.RawRepresentation as IEnumerable<AGUIToolCallArgumentFragment>,
        };
        var client = new A2UIChatClient(planner, subagent, options);

        await foreach (var _ in client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "weather then a card")]))
        {
        }

        var roundTwoContents = planner.RoundTwoHistory.SelectMany(m => m.Contents).ToList();
        Assert.Contains(
            roundTwoContents.OfType<FunctionCallContent>(),
            c => c.Name == "get_weather");
        Assert.Contains(
            roundTwoContents.OfType<FunctionResultContent>(),
            r => r.CallId == "dev-1");
    }

    // A planner IChatClient whose first turn is a developer tool call + result (as the inner
    // function-invocation layer would surface it) followed by a generate_a2ui call; round 2
    // records the history it was given, then ends with text so the loop terminates.
    private sealed class DevToolThenGenerateClient : IChatClient
    {
        public IReadOnlyList<ChatMessage> RoundTwoHistory { get; private set; } = [];
        private int _round;

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            if (_round++ == 0)
            {
                yield return new ChatResponseUpdate(
                    ChatRole.Assistant,
                    [new FunctionCallContent("dev-1", "get_weather", new Dictionary<string, object?> { ["city"] = "SF" })]);
                yield return new ChatResponseUpdate(
                    ChatRole.Tool,
                    [new FunctionResultContent("dev-1", "sunny")]);
                yield return new ChatResponseUpdate(
                    ChatRole.Assistant,
                    [new FunctionCallContent("gen-1", A2UIConstants.GenerateA2UIToolName, new Dictionary<string, object?> { ["intent"] = "create" })]);
            }
            else
            {
                RoundTwoHistory = messages.ToList();
                yield return new ChatResponseUpdate(ChatRole.Assistant, "Done.");
            }
        }

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    // A planner IChatClient: round 1 emits a single generate_a2ui tool call; later rounds emit only
    // text so the decorator's planner loop terminates.
    private sealed class ScriptedPlannerClient : IChatClient
    {
        public const string GenerateCallId = "gen-1";
        private int _round;

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            if (_round++ == 0)
            {
                yield return new ChatResponseUpdate(
                    ChatRole.Assistant,
                    [new FunctionCallContent(GenerateCallId, A2UIConstants.GenerateA2UIToolName, new Dictionary<string, object?> { ["intent"] = "create" })]);
            }
            else
            {
                yield return new ChatResponseUpdate(ChatRole.Assistant, "Done.");
            }
        }

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }

    // A render sub-agent IChatClient: streams one arg fragment (carrying the render call id on its
    // RawRepresentation) then throws a recoverable error, on every attempt.
    private sealed class MidStreamThrowingSubagentClient : IChatClient
    {
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            yield return new ChatResponseUpdate(ChatRole.Assistant, [])
            {
                RawRepresentation = new List<AGUIToolCallArgumentFragment>
                {
                    new() { Index = 0, ToolCallId = RenderCallId, FunctionName = A2UIConstants.RenderA2UIToolName, ArgumentsDelta = "{\"surfaceId\":\"s\"," },
                },
            };

            // Recoverable transient failure (not a programmer error / cancellation): the recovery
            // loop should retry, and each attempt reaches this same throw.
            throw new TimeoutException("simulated mid-stream provider fault");
        }

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }
}
