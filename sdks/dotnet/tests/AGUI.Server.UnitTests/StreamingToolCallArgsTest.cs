using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

/// <summary>
/// Tests for the provider-neutral incremental tool-call argument tap
/// (<see cref="AGUIStreamOptions.MapStreamingToolCallArguments"/> +
/// <see cref="AGUIToolCallArgumentFragment"/>): fragments surface as incremental
/// <c>TOOL_CALL_ARGS</c>, the coalesced call closes it, an index reused by a new call after a
/// never-coalesced one is not misattributed, and a never-coalesced call is swept at end of stream.
/// </summary>
public sealed class StreamingToolCallArgsTest
{
    private const string ThreadId = "thread-1";
    private const string RunId = "run-1";

    // The extractor reads synthetic fragments stuffed into RawRepresentation, so the tap logic is
    // exercised without any provider SDK.
    private static AGUIStreamOptions OptionsWithExtractor() =>
        new AGUIStreamOptions().MapStreamingToolCallArguments(
            u => u.RawRepresentation as IEnumerable<AGUIToolCallArgumentFragment>);

    private static ChatResponseUpdate Fragment(int index, string? id, string? name, string delta) =>
        new(ChatRole.Assistant, [])
        {
            RawRepresentation = new List<AGUIToolCallArgumentFragment>
            {
                new() { Index = index, ToolCallId = id, FunctionName = name, ArgumentsDelta = delta },
            },
        };

    private static ChatResponseUpdate Coalesced(string id, string name) =>
        new(ChatRole.Assistant, [new FunctionCallContent(id, name)]);

    private static async Task<List<BaseEvent>> RunAsync(params ChatResponseUpdate[] updates)
    {
        var context = new RunAgentInput { ThreadId = ThreadId, RunId = RunId }
            .ToChatRequestContext(AIJsonUtilities.DefaultOptions, OptionsWithExtractor());
        var events = new List<BaseEvent>();
        await foreach (var evt in ToAsyncEnumerable(updates).AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        return events;
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> ToAsyncEnumerable(ChatResponseUpdate[] items)
    {
        foreach (var item in items)
        {
            yield return item;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    [Fact]
    public async Task Fragments_StreamIncrementally_ThenCoalescedCallClosesAsync()
    {
        // Arrange: one call streamed as three arg fragments, then its coalesced FunctionCallContent.
        var updates = new[]
        {
            Fragment(0, "call_a", "get_weather", "{\"ci"),
            Fragment(0, null, null, "ty\":\"Pa"),
            Fragment(0, null, null, "ris\"}"),
            Coalesced("call_a", "get_weather"),
        };

        // Act
        var events = await RunAsync(updates);

        // Assert: exactly one START, incremental ARGS reassembling the full JSON, exactly one END.
        var start = events.OfType<ToolCallStartEvent>().Single();
        Assert.Equal("call_a", start.ToolCallId);
        Assert.Equal("get_weather", start.ToolCallName);
        var args = events.OfType<ToolCallArgsEvent>().Where(a => a.ToolCallId == "call_a").ToList();
        Assert.Equal(3, args.Count);
        Assert.Equal("{\"city\":\"Paris\"}", string.Concat(args.Select(a => a.Delta)));
        Assert.Single(events.OfType<ToolCallEndEvent>(), e => e.ToolCallId == "call_a");
    }

    [Fact]
    public async Task ParallelCalls_TrackedByIndex_EachBalancedAsync()
    {
        // Arrange: two concurrent calls at indexes 0 and 1, interleaved fragments, both coalesce.
        var updates = new[]
        {
            Fragment(0, "call_a", "a", "{\"x\":1}"),
            Fragment(1, "call_b", "b", "{\"y\":2}"),
            Coalesced("call_a", "a"),
            Coalesced("call_b", "b"),
        };

        // Act
        var events = await RunAsync(updates);

        // Assert: each call opened once, args attributed to the right id, each closed once.
        Assert.Equal(2, events.OfType<ToolCallStartEvent>().Count());
        Assert.Equal("{\"x\":1}", string.Concat(events.OfType<ToolCallArgsEvent>().Where(a => a.ToolCallId == "call_a").Select(a => a.Delta)));
        Assert.Equal("{\"y\":2}", string.Concat(events.OfType<ToolCallArgsEvent>().Where(a => a.ToolCallId == "call_b").Select(a => a.Delta)));
        Assert.Single(events.OfType<ToolCallEndEvent>(), e => e.ToolCallId == "call_a");
        Assert.Single(events.OfType<ToolCallEndEvent>(), e => e.ToolCallId == "call_b");
    }

    [Fact]
    public async Task IndexReusedByNewCall_AfterUncoalescedCall_ClosesStaleAndDoesNotMisattributeAsync()
    {
        // Arrange: call_a streams at index 0 but never coalesces (mid-stream failure); a new call_b
        // then reuses index 0 (providers restart tool-call indexes each turn).
        var updates = new[]
        {
            Fragment(0, "call_a", "render", "{\"partial\":"),
            Fragment(0, "call_b", "render", "{\"good\":1}"),
            Coalesced("call_b", "render"),
        };

        // Act
        var events = await RunAsync(updates);

        // Assert: call_a is closed (not left dangling) and its args are NOT re-attributed to call_b;
        // call_b opens fresh and carries only its own args.
        Assert.Single(events.OfType<ToolCallStartEvent>(), e => e.ToolCallId == "call_a");
        Assert.Single(events.OfType<ToolCallEndEvent>(), e => e.ToolCallId == "call_a");
        Assert.Single(events.OfType<ToolCallStartEvent>(), e => e.ToolCallId == "call_b");
        var bArgs = string.Concat(events.OfType<ToolCallArgsEvent>().Where(a => a.ToolCallId == "call_b").Select(a => a.Delta));
        Assert.Equal("{\"good\":1}", bArgs);
        Assert.DoesNotContain("partial", string.Concat(events.OfType<ToolCallArgsEvent>().Where(a => a.ToolCallId == "call_b").Select(a => a.Delta)));
    }

    [Fact]
    public async Task IndexReusedBySameId_AfterUncoalescedCall_ReopensCleanlyAsync()
    {
        // Arrange: a provider (or replay fixture) reuses the SAME id at index 0 for a retried
        // call that never coalesced. The new first fragment (carrying the function name) must
        // still close the stale call and reopen, so the client never sees a second START for an
        // id already "in progress".
        var updates = new[]
        {
            Fragment(0, "call_a", "render", "{\"partial\":"),
            Fragment(0, "call_a", "render", "{\"good\":1}"),
            Coalesced("call_a", "render"),
        };

        // Act
        var events = await RunAsync(updates);

        // Assert: START and END strictly alternate (no doubled START), and the two calls' args are
        // SEGMENTED, not concatenated. Without the stale-close, the reused id would accumulate one
        // corrupt args string "{\"partial\":{\"good\":1}"; with it, each segment stands alone.
        var open = false;
        var segments = new List<string>();
        foreach (var e in events)
        {
            switch (e)
            {
                case ToolCallStartEvent:
                    Assert.False(open, "a TOOL_CALL_START was emitted while a call was already open");
                    open = true;
                    segments.Add(string.Empty);
                    break;
                case ToolCallArgsEvent a:
                    segments[^1] += a.Delta;
                    break;
                case ToolCallEndEvent:
                    open = false;
                    break;
            }
        }

        Assert.False(open, "a call was left open at end of stream");
        Assert.Equal(2, segments.Count);
        Assert.Equal("{\"partial\":", segments[0]);
        Assert.Equal("{\"good\":1}", segments[1]);
    }

    [Fact]
    public async Task UncoalescedCall_ClosedByEndOfStreamSweepAsync()
    {
        // Arrange: a call streams fragments but its coalesced FunctionCallContent never arrives.
        var updates = new[]
        {
            Fragment(0, "call_a", "render", "{\"a\":"),
            Fragment(0, null, null, "1}"),
        };

        // Act
        var events = await RunAsync(updates);

        // Assert: the end-of-stream sweep closes it so no call is left "in progress".
        Assert.Single(events.OfType<ToolCallStartEvent>(), e => e.ToolCallId == "call_a");
        Assert.Single(events.OfType<ToolCallEndEvent>(), e => e.ToolCallId == "call_a");
    }
}
