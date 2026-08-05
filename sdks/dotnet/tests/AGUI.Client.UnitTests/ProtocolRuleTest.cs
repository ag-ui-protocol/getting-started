using System.Buffers;
using System.Net;
using System.Net.ServerSentEvents;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

/// <summary>
/// Tests that validate AG-UI protocol rules by feeding event sequences
/// through EventStreamConverter.AsChatResponseUpdates — the same conversion
/// path AGUIChatClient uses internally. Ported from the TypeScript SDK's
/// event verifier test suite.
/// </summary>
public sealed class ProtocolRuleTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    // ────────────────────────────────────────────────
    // Lifecycle rules
    // ────────────────────────────────────────────────

    [Fact]
    public async Task ValidCompleteSequence_ProducesAllEvents()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Collection(result,
            u => Assert.IsType<RunStartedEvent>(u.RawRepresentation),
            u => Assert.IsType<TextMessageContentEvent>(u.RawRepresentation),
            u => Assert.IsType<RunFinishedEvent>(u.RawRepresentation));
    }

    [Fact]
    public async Task RunError_ProducesErrorContentUpdate()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunErrorEvent { Message = "Something failed", Code = "ERR01" }
        };

        var result = await ProcessEventsAsync(events);
        var update = result[1];
        var error = Assert.IsType<ErrorContent>(Assert.Single(update.Contents));
        Assert.Equal("Something failed", error.Message);
        Assert.Equal("ERR01", error.ErrorCode);
        Assert.IsType<RunErrorEvent>(update.RawRepresentation);
        Assert.Equal("t1", update.ConversationId);
        Assert.Equal("r1", update.ResponseId);
    }

    [Fact]
    public async Task RunErrorAsFirstEvent_ProducesErrorContentUpdate()
    {
        var events = new BaseEvent[]
        {
            new RunErrorEvent { Message = "Immediate failure" }
        };

        var result = await ProcessEventsAsync(events);
        var error = Assert.IsType<ErrorContent>(Assert.Single(Assert.Single(result).Contents));
        Assert.Equal("Immediate failure", error.Message);
        Assert.Null(error.ErrorCode);
    }

    [Fact]
    public async Task RunFinished_IsLastEvent()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.IsType<RunFinishedEvent>(result.Last().RawRepresentation);
    }

    [Fact]
    public async Task RunStarted_SetsThreadAndRunId()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "thread-42", RunId = "run-7" },
            new RunFinishedEvent { ThreadId = "thread-42", RunId = "run-7" }
        };

        var result = await ProcessEventsAsync(events);
        var started = Assert.IsType<RunStartedEvent>(result[0].RawRepresentation);
        Assert.Equal("thread-42", started.ThreadId);
        Assert.Equal("run-7", started.RunId);
    }

    // ────────────────────────────────────────────────
    // Text message lifecycle rules
    // ────────────────────────────────────────────────

    [Fact]
    public async Task TextMessage_ValidLifecycle_ProducesTextUpdates()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello " },
            new TextMessageContentEvent { MessageId = "m1", Delta = "world" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Hello ", u.Text),
            u => Assert.Equal("world", u.Text));
    }

    [Fact]
    public async Task TextMessage_ConcurrentWithDifferentIds_Succeeds()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            // Start a second message with a different ID — allowed
            new TextMessageStartEvent { MessageId = "m2", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m2", Delta = "World" },
            new TextMessageEndEvent { MessageId = "m1" },
            new TextMessageEndEvent { MessageId = "m2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Hello", u.Text),
            u => Assert.Equal("World", u.Text));
    }

    [Fact]
    public async Task TextMessage_DuplicateId_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            // Start another message with the SAME ID — duplicate, should throw
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("m1", ex.Message);
        Assert.Contains("already in progress", ex.Message);
    }

    [Fact]
    public async Task TextMessage_EndForUnstartedId_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            // End with wrong message ID
            new TextMessageEndEvent { MessageId = "wrong-id" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("wrong-id", ex.Message);
        Assert.Contains("No active text message", ex.Message);
    }

    [Fact]
    public async Task TextMessage_ContentBeforeStart_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("m1", ex.Message);
        Assert.Contains("No active text message", ex.Message);
    }

    [Fact]
    public async Task TextMessage_EndBeforeStart_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageEndEvent { MessageId = "m1" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("m1", ex.Message);
        Assert.Contains("TEXT_MESSAGE_END", ex.Message);
    }

    [Fact]
    public async Task TextMessage_SequentialMessages_Succeeds()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "First" },
            new TextMessageEndEvent { MessageId = "m1" },
            new TextMessageStartEvent { MessageId = "m2", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m2", Delta = "Second" },
            new TextMessageEndEvent { MessageId = "m2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("First", u.Text),
            u => Assert.Equal("Second", u.Text));
    }

    [Fact]
    public async Task TextMessage_UserRole_PreservesRole()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "user" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "echo" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u =>
            {
                Assert.Equal("echo", u.Text);
                Assert.Equal(ChatRole.User, u.Role);
            });
    }

    // ────────────────────────────────────────────────
    // Tool call lifecycle rules
    // ────────────────────────────────────────────────

    [Fact]
    public async Task ToolCall_ValidLifecycle_ProducesFunctionCallContent()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "get_weather" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"city\":" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "\"NYC\"}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            fcc =>
            {
                Assert.Equal("get_weather", fcc.Name);
                Assert.Equal("tc1", fcc.CallId);
                Assert.NotNull(fcc.Arguments);
                Assert.Equal("NYC", fcc.Arguments["city"]?.ToString());
            });
    }

    [Fact]
    public async Task ToolCall_ConcurrentWithDifferentIds_AllComplete()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "weather" },
            new ToolCallStartEvent { ToolCallId = "tc2", ToolCallName = "search" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"loc\":\"NYC\"}" },
            new ToolCallArgsEvent { ToolCallId = "tc2", Delta = "{\"q\":\"test\"}" },
            new ToolCallEndEvent { ToolCallId = "tc2" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var toolCalls = result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()).ToList();
        Assert.Equal(2, toolCalls.Count);
        Assert.Contains(toolCalls, f => f.Name == "weather" && f.CallId == "tc1");
        Assert.Contains(toolCalls, f => f.Name == "search" && f.CallId == "tc2");
    }

    [Fact]
    public async Task ToolCall_ArgsBeforeStart_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallArgsEvent { ToolCallId = "nonexistent", Delta = "{}" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("nonexistent", ex.Message);
        Assert.Contains("No active tool call", ex.Message);
    }

    [Fact]
    public async Task ToolCall_EndBeforeStart_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallEndEvent { ToolCallId = "nonexistent" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("nonexistent", ex.Message);
        Assert.Contains("TOOL_CALL_END", ex.Message);
    }

    [Fact]
    public async Task ToolCall_DuplicateId_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "first" },
            // Duplicate same ID without ending first — should throw
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "second" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("tc1", ex.Message);
        Assert.Contains("already in progress", ex.Message);
    }

    [Fact]
    public async Task ToolCall_EmptyArgs_ProducesNullArguments()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "no_args" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            fcc =>
            {
                Assert.Equal("no_args", fcc.Name);
                Assert.Null(fcc.Arguments);
            });
    }

    [Fact]
    public async Task ToolCall_SequentialCalls_AllComplete()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "first" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new ToolCallStartEvent { ToolCallId = "tc2", ToolCallName = "second" },
            new ToolCallArgsEvent { ToolCallId = "tc2", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            f => Assert.Equal("first", f.Name),
            f => Assert.Equal("second", f.Name));
    }

    // ────────────────────────────────────────────────
    // Interleaving / nesting rules
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Interleaving_ToolCallDuringTextMessage_BothComplete()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Let me check " },
            // Tool call starts while text message is active
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "weather" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"city\":\"NYC\"}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            // Text message continues
            new TextMessageContentEvent { MessageId = "m1", Delta = "the weather." },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Let me check ", u.Text),
            u => Assert.Equal("the weather.", u.Text));

        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            f => Assert.Equal("weather", f.Name));
    }

    [Fact]
    public async Task Interleaving_TextMessageDuringToolCall_BothComplete()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"q\":" },
            // Text starts while tool call is active
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Searching..." },
            new TextMessageEndEvent { MessageId = "m1" },
            // Tool call continues
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "\"test\"}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Searching...", u.Text));

        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            f =>
            {
                Assert.Equal("search", f.Name);
                Assert.NotNull(f.Arguments);
                Assert.Equal("test", f.Arguments!["q"]?.ToString());
            });
    }

    // ────────────────────────────────────────────────
    // Meta events (allowed in any context)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task MetaEvents_StateSnapshotDuringTextMessage_PassesThrough()
    {
        var stateValue = JsonDocument.Parse("{\"count\":1}").RootElement.Clone();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new StateSnapshotEvent { Snapshot = stateValue },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Contains(result, u => u.RawRepresentation is StateSnapshotEvent);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Hello", u.Text));
    }

    [Fact]
    public async Task MetaEvents_StateDeltaDuringToolCall_PassesThrough()
    {
        var delta = JsonDocument.Parse("[{\"op\":\"replace\",\"path\":\"/x\",\"value\":5}]").RootElement.Clone();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "calc" },
            new StateDeltaEvent { Delta = delta },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Contains(result, u => u.RawRepresentation is StateDeltaEvent);
        Assert.Single(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()));
    }

    [Fact]
    public async Task MetaEvents_CustomEventAnyContext_PassesThrough()
    {
        var customValue = JsonDocument.Parse("{\"action\":\"highlight\"}").RootElement.Clone();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new CustomEvent { Name = "ui_hint", Value = customValue },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new CustomEvent { Name = "progress", Value = null },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hi" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Collection(result.Select(u => u.RawRepresentation).OfType<CustomEvent>(),
            e => Assert.Equal("ui_hint", e.Name),
            e => Assert.Equal("progress", e.Name));
    }

    [Fact]
    public async Task MetaEvents_RawEventDuringToolCall_PassesThrough()
    {
        var rawValue = JsonDocument.Parse("{\"debug\":true}").RootElement.Clone();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "run" },
            new RawEvent { Event = rawValue },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Contains(result, u => u.RawRepresentation is RawEvent);
        Assert.Single(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()));
    }

    // ────────────────────────────────────────────────
    // Step events (validated by EventStreamConverter)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Steps_DuringTextMessage_DoNotInterfere()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "planning" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            new StepFinishedEvent { StepName = "planning" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Hello", u.Text));
    }

    [Fact]
    public async Task Steps_DuringToolCall_DoNotInterfere()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "calc" },
            new StepStartedEvent { StepName = "compute" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"x\":1}" },
            new StepFinishedEvent { StepName = "compute" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            f => Assert.Equal("calc", f.Name));
    }

    [Fact]
    public async Task Steps_FinishMismatchedName_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "step1" },
            new StepFinishedEvent { StepName = "wrong_name" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("wrong_name", ex.Message);
        Assert.Contains("not started", ex.Message);
    }

    [Fact]
    public async Task Steps_FinishWithoutStart_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepFinishedEvent { StepName = "never_started" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("never_started", ex.Message);
        Assert.Contains("not started", ex.Message);
    }

    [Fact]
    public async Task Steps_DuplicateName_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "step1" },
            new StepStartedEvent { StepName = "step1" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("step1", ex.Message);
        Assert.Contains("already active", ex.Message);
    }

    [Fact]
    public async Task Steps_ConcurrentDifferentNames_Succeeds()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "step1" },
            new StepStartedEvent { StepName = "step2" },
            new StepFinishedEvent { StepName = "step2" },
            new StepFinishedEvent { StepName = "step1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Contains(result, u => u.RawRepresentation is StepStartedEvent s && s.StepName == "step1");
        Assert.Contains(result, u => u.RawRepresentation is StepStartedEvent s && s.StepName == "step2");
    }

    [Fact]
    public async Task Steps_ActiveAtRunFinished_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "unfinished" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("unfinished", ex.Message);
        Assert.Contains("steps are still active", ex.Message);
    }

    // ────────────────────────────────────────────────
    // Lifecycle validation (EventStreamConverter rules)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Lifecycle_FirstEventMustBeRunStarted()
    {
        var events = new BaseEvent[]
        {
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("First event must be 'RUN_STARTED'", ex.Message);
    }

    [Fact]
    public async Task Lifecycle_RunErrorAsFirstEvent_IsAllowed()
    {
        var events = new BaseEvent[]
        {
            new RunErrorEvent { Message = "Immediate failure" }
        };

        Assert.Single(await ProcessEventsAsync(events));
    }

    [Fact]
    public async Task Lifecycle_NoEventsAfterRunFinished()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("already finished", ex.Message);
    }

    [Fact]
    public async Task Lifecycle_NoEventsAfterRunError()
    {
        // RunError emits an ErrorContent update and terminates the run; subsequent events are rejected.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunErrorEvent { Message = "boom" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("already errored", ex.Message);
    }

    [Fact]
    public async Task Lifecycle_CannotStartNewRunWhileActive()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("run is still active", ex.Message);
    }

    [Fact]
    public async Task Lifecycle_RunFinishedWithActiveMessages_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Hello" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("text messages are still active", ex.Message);
        Assert.Contains("m1", ex.Message);
    }

    [Fact]
    public async Task Lifecycle_RunFinishedWithActiveToolCalls_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "fetch" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("tool calls are still active", ex.Message);
        Assert.Contains("tc1", ex.Message);
    }

    [Fact]
    public async Task Lifecycle_RunErrorAfterRunFinished_StillTerminal()
    {
        // RUN_ERROR remains allowed after RUN_FINISHED, emits an ErrorContent update, and makes the stream terminal.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunErrorEvent { Message = "late error" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("already errored", ex.Message);
    }

    // ────────────────────────────────────────────────
    // Multi-run support (state reset between runs)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task MultiRun_SequentialRuns_Succeeds()
    {
        var events = new BaseEvent[]
        {
            // First run
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Run 1" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            // Second run
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new TextMessageStartEvent { MessageId = "m2", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m2", Delta = "Run 2" },
            new TextMessageEndEvent { MessageId = "m2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" },
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Run 1", u.Text),
            u => Assert.Equal("Run 2", u.Text));
    }

    [Fact]
    public async Task MultiRun_ReuseMessageIdsAcrossRuns_Succeeds()
    {
        var events = new BaseEvent[]
        {
            // First run
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "First" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            // Second run reuses message ID "m1"
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Second" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" },
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("First", u.Text),
            u => Assert.Equal("Second", u.Text));
    }

    [Fact]
    public async Task MultiRun_WithToolCalls_Succeeds()
    {
        var events = new BaseEvent[]
        {
            // First run with tool call
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            // Second run with tool call
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new ToolCallStartEvent { ToolCallId = "tc2", ToolCallName = "fetch" },
            new ToolCallArgsEvent { ToolCallId = "tc2", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" },
        };

        var result = await ProcessEventsAsync(events);
        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            f => Assert.Equal("search", f.Name),
            f => Assert.Equal("fetch", f.Name));
    }

    [Fact]
    public async Task MultiRun_WithSteps_Succeeds()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "plan" },
            new StepFinishedEvent { StepName = "plan" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },

            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new StepStartedEvent { StepName = "plan" },
            new StepFinishedEvent { StepName = "plan" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" },
        };

        var result = await ProcessEventsAsync(events);
        Assert.Equal(2, result.Count(u => u.RawRepresentation is RunFinishedEvent));
    }

    [Fact]
    public async Task MultiRun_ThreeSequentialRuns_Succeeds()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r3" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r3" },
        };

        var result = await ProcessEventsAsync(events);
        Assert.Equal(3, result.Count(u => u.RawRepresentation is RunStartedEvent));
        Assert.Equal(3, result.Count(u => u.RawRepresentation is RunFinishedEvent));
    }

    [Fact]
    public async Task MultiRun_RunErrorBlocksAnotherRunInSameStream()
    {
        // RunError emits an ErrorContent update and prevents another run from starting in the same stream.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunErrorEvent { Message = "boom" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => ProcessEventsAsync(events));
        Assert.Contains("already errored", ex.Message);
    }

    // ────────────────────────────────────────────────
    // Reasoning events
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Reasoning_FullLifecycle_ProducesReasoningEvents()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent(),
            new ReasoningMessageStartEvent(),
            new ReasoningMessageContentEvent { Delta = "Thinking..." },
            new ReasoningMessageEndEvent(),
            new ReasoningEndEvent(),
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Answer" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Contains(result, u => u.RawRepresentation is ReasoningStartEvent);
        Assert.Contains(result, u => u.RawRepresentation is ReasoningMessageContentEvent c && c.Delta == "Thinking...");
        Assert.Contains(result, u => u.RawRepresentation is ReasoningEndEvent);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Answer", u.Text));
    }

    // ────────────────────────────────────────────────
    // Activity events
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Activity_SnapshotAndDelta_PassThrough()
    {
        var content = JsonDocument.Parse("{\"status\":\"running\"}").RootElement.Clone();
        var patchDelta = JsonDocument.Parse("[{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"done\"}]").RootElement.Clone();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "PLAN", Content = content },
            new ActivityDeltaEvent { MessageId = "a1", Patch = patchDelta },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Contains(result, u => u.RawRepresentation is ActivitySnapshotEvent);
        Assert.Contains(result, u => u.RawRepresentation is ActivityDeltaEvent);
    }

    // ────────────────────────────────────────────────
    // Complex scenarios (ported from verify.concurrent.test.ts)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Complex_FiveConcurrentToolCalls_AllComplete()
    {
        var eventList = new List<BaseEvent>
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" }
        };

        // Start 5 tool calls
        for (int i = 0; i < 5; i++)
        {
            eventList.Add(new ToolCallStartEvent
            {
                ToolCallId = $"tc{i}",
                ToolCallName = $"tool_{i}"
            });
        }

        // Interleave args
        for (int round = 0; round < 3; round++)
        {
            for (int i = 0; i < 5; i++)
            {
                eventList.Add(new ToolCallArgsEvent
                {
                    ToolCallId = $"tc{i}",
                    Delta = round == 0 ? "{\"r\":" : round == 1 ? $"{i}" : "}"
                });
            }
        }

        // End all
        for (int i = 0; i < 5; i++)
        {
            eventList.Add(new ToolCallEndEvent { ToolCallId = $"tc{i}" });
        }

        eventList.Add(new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        var result = await ProcessEventsAsync(eventList.ToArray());
        var toolCalls = result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()).ToList();
        Assert.Equal(5, toolCalls.Count);

        for (int i = 0; i < 5; i++)
        {
            var call = toolCalls.First(c => c.CallId == $"tc{i}");
            Assert.Equal($"tool_{i}", call.Name);
            Assert.NotNull(call.Arguments);
            Assert.Equal(i.ToString(System.Globalization.CultureInfo.InvariantCulture), call.Arguments["r"]?.ToString());
        }
    }

    [Fact]
    public async Task Complex_TextAndToolCallsInterleaved_AllComplete()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },

            // First text message
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "I'll help. " },

            // Tool call starts during text
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"q\":\"info\"}" },

            // More text
            new TextMessageContentEvent { MessageId = "m1", Delta = "Searching..." },

            // Tool call ends
            new ToolCallEndEvent { ToolCallId = "tc1" },

            // Text ends
            new TextMessageEndEvent { MessageId = "m1" },

            // Second text message
            new TextMessageStartEvent { MessageId = "m2", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m2", Delta = "Found it!" },
            new TextMessageEndEvent { MessageId = "m2" },

            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("I'll help. ", u.Text),
            u => Assert.Equal("Searching...", u.Text),
            u => Assert.Equal("Found it!", u.Text));

        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            f => Assert.Equal("search", f.Name));
    }

    [Fact]
    public async Task Complex_MixedEventsFullScenario_ProducesAllOutputs()
    {
        var stateValue = JsonDocument.Parse("{\"phase\":\"init\"}").RootElement.Clone();
        var customValue = JsonDocument.Parse("{\"hint\":\"show_spinner\"}").RootElement.Clone();

        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },

            // State & custom at top level
            new StateSnapshotEvent { Snapshot = stateValue },
            new CustomEvent { Name = "ui", Value = customValue },

            // Reasoning
            new ReasoningStartEvent(),
            new ReasoningMessageStartEvent(),
            new ReasoningMessageContentEvent { Delta = "Planning" },
            new ReasoningMessageEndEvent(),
            new ReasoningEndEvent(),

            // Step + text message
            new StepStartedEvent { StepName = "generate" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "Here" },
            new TextMessageEndEvent { MessageId = "m1" },
            new StepFinishedEvent { StepName = "generate" },

            // Tool call
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "fetch" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },

            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        // Verify all event types were observed
        Assert.Contains(result, u => u.RawRepresentation is RunStartedEvent);
        Assert.Contains(result, u => u.RawRepresentation is StateSnapshotEvent);
        Assert.Contains(result, u => u.RawRepresentation is CustomEvent);
        Assert.Contains(result, u => u.RawRepresentation is ReasoningMessageContentEvent);
        Assert.Collection(result.Where(u => u.Text is { Length: > 0 }),
            u => Assert.Equal("Here", u.Text));
        Assert.Collection(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()),
            f => Assert.Equal("fetch", f.Name));
        Assert.Contains(result, u => u.RawRepresentation is RunFinishedEvent);
    }

    // ────────────────────────────────────────────────
    // Helpers — process events through EventStreamConverter.AsChatResponseUpdates
    // ────────────────────────────────────────────────

    private static async Task<List<ChatResponseUpdate>> ProcessEventsAsync(BaseEvent[] events)
    {
        using var httpClient = CreateMockHttpClient(events);
        var service = new AGUIHttpTransport(httpClient, "http://localhost/agent");
        var input = new RunAgentInput { ThreadId = "t1", RunId = "r1" };

        var updates = new List<ChatResponseUpdate>();

        await foreach (var update in EventStreamConverter.AsChatResponseUpdates(
            service.SendAsync(input, CancellationToken.None), s_options).ConfigureAwait(false))
        {
            updates.Add(update);
        }

        return updates;
    }

    private static HttpClient CreateMockHttpClient(BaseEvent[] events)
    {
        var stream = new MemoryStream();
        var items = ToSseItems(events);
        SseFormatter.WriteAsync(items, stream, SerializeEvent).GetAwaiter().GetResult();
        stream.Position = 0;

        var handler = new TestDelegatingHandler((_, _) =>
        {
            return Task.FromResult(new HttpResponseMessage
            {
                StatusCode = HttpStatusCode.OK,
                Content = new StreamContent(stream) { Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("text/event-stream") } }
            });
        });

        return new HttpClient(handler);
    }

    private static void SerializeEvent(SseItem<BaseEvent> item, IBufferWriter<byte> writer)
    {
        using var jsonWriter = new Utf8JsonWriter(writer);
        JsonSerializer.Serialize(jsonWriter, item.Data, AGUIJsonSerializerContext.Default.BaseEvent);
    }

#pragma warning disable CS1998 // Async method lacks 'await' operators
    private static async IAsyncEnumerable<SseItem<BaseEvent>> ToSseItems(BaseEvent[] events)
#pragma warning restore CS1998
    {
        foreach (var evt in events)
        {
            yield return new SseItem<BaseEvent>(evt);
        }
    }

    private sealed class TestDelegatingHandler : DelegatingHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;

        public TestDelegatingHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return _handler(request, cancellationToken);
        }
    }
}
