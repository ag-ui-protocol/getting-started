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
    public async Task ToolCall_EndSurfacesFunctionCallBeforeSiblingResult()
    {
        // TOOL_CALL_END must yield FunctionCallContent immediately. Waiting until
        // every parallel TOOL_CALL_RESULT arrived hid in-progress backend tools
        // and delayed unrelated calls (issue #2577).
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = "slow" },
            new ToolCallEndEvent { ToolCallId = "c1" },
            new ToolCallStartEvent { ToolCallId = "c2", ToolCallName = "fast" },
            new ToolCallEndEvent { ToolCallId = "c2" },
            new ToolCallResultEvent { MessageId = "r2", ToolCallId = "c2", Content = "done-2" },
            new ToolCallResultEvent { MessageId = "r1", ToolCallId = "c1", Content = "done-1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var kinds = result
            .Select(u => u.Contents.FirstOrDefault() switch
            {
                FunctionCallContent fcc => $"call:{fcc.CallId}",
                FunctionResultContent frc => $"result:{frc.CallId}",
                _ => null
            })
            .Where(s => s is not null)
            .ToList();

        Assert.Equal(["call:c1", "call:c2", "result:c2", "result:c1"], kinds);
    }

    [Fact]
    public async Task ToolCall_InterruptEmitsApprovalAfterTheCallHasAlreadySurfaced()
    {
        // TOOL_CALL_END yields FunctionCallContent immediately so a UI can show
        // the in-progress call. RUN_FINISHED with a tool-call interrupt still
        // emits ToolApprovalRequestContent for HITL; it must not swallow the
        // earlier call update or skip the approval.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "delete_file" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent
            {
                ThreadId = "t1",
                RunId = "r1",
                Outcome = new RunFinishedInterruptOutcome
                {
                    Interrupts =
                    {
                        new AGUIInterrupt
                        {
                            Id = "int-1",
                            Reason = InterruptReasons.ToolCall,
                            ToolCallId = "tc1"
                        }
                    }
                }
            }
        };

        var result = await ProcessEventsAsync(events);
        var callIndex = result.FindIndex(u => u.Contents.OfType<FunctionCallContent>().Any());
        var approvalIndex = result.FindIndex(u => u.Contents.OfType<ToolApprovalRequestContent>().Any());
        Assert.InRange(callIndex, 0, result.Count - 1);
        Assert.InRange(approvalIndex, 0, result.Count - 1);
        Assert.True(callIndex < approvalIndex);
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
    // Subagent lifecycle and attribution rules
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Subagent_WellFormedLifecycle_PassesThrough()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "found it", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        // The lifecycle events reach the caller as RawRepresentation, and the attribution
        // survives the SSE round trip this helper performs.
        var started = Assert.Single(result.Select(u => u.RawRepresentation).OfType<SubagentStartedEvent>());
        Assert.Equal("researcher", started.Name);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<SubagentFinishedEvent>());
        Assert.Contains(result, u => u.RawRepresentation is TextMessageContentEvent { SubagentRunId: "s1" });
    }

    [Fact]
    public async Task Subagent_DuplicateStarted_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("already active", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_FinishedWithoutStarted_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentFinishedEvent { SubagentRunId = "ghost" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("no active subagent", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ErrorWithoutStarted_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentErrorEvent { SubagentRunId = "ghost", Message = "boom" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("no active subagent", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_UnknownParent_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "child", Name = "inner", ParentSubagentRunId = "never-started" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("has not been started", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_RunFinishedWhileOpen_Throws()
    {
        // A subagent left open at RUN_FINISHED means the consumer would show it running
        // forever, so the run is rejected instead.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        // "still active" alone is shared with the step and text-message guards, so it would
        // pass on a stream rejected for an unrelated reason.
        Assert.Contains("Cannot send 'RUN_FINISHED' while subagents are still active: s1", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ErrorClosesTheSubagent_SoRunMayFinish()
    {
        // SUBAGENT_ERROR is terminal just like SUBAGENT_FINISHED: a failed subagent is a
        // closed subagent, so the run is free to end.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new SubagentErrorEvent { SubagentRunId = "s1", Message = "boom" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<SubagentErrorEvent>());
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_NestedAndParallel_LinkByIdentityNotArrivalOrder()
    {
        // Two subagents run in parallel and one of them nests a child. The events are
        // deliberately interleaved so that arrival order does NOT match the parent/child
        // structure: if parents were inferred from "most recently started" rather than
        // from the explicit ParentSubagentRunId, `child` would be attached to `b`.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "a", Name = "alpha" },
            new SubagentStartedEvent { SubagentRunId = "b", Name = "beta" },
            new SubagentStartedEvent { SubagentRunId = "child", Name = "inner", ParentSubagentRunId = "a" },
            // Sequenced rather than interleaved: two concurrently-open text messages are
            // not a shape this client supports (ToolCallBuilder tracks interleaved tool
            // calls independently, but TextMessageBuilder handles one message at a time —
            // see ConcurrentBuilderTest). The subagent lifecycle above is what is
            // interleaved, which is what this test is about.
            new TextMessageStartEvent { MessageId = "mb", Role = "assistant", SubagentRunId = "b" },
            new TextMessageContentEvent { MessageId = "mb", Delta = "from beta", SubagentRunId = "b" },
            new TextMessageEndEvent { MessageId = "mb", SubagentRunId = "b" },
            new TextMessageStartEvent { MessageId = "mc", Role = "assistant", SubagentRunId = "child" },
            new TextMessageContentEvent { MessageId = "mc", Delta = "from child", SubagentRunId = "child" },
            new TextMessageEndEvent { MessageId = "mc", SubagentRunId = "child" },
            new SubagentFinishedEvent { SubagentRunId = "child" },
            new SubagentFinishedEvent { SubagentRunId = "b" },
            new SubagentFinishedEvent { SubagentRunId = "a" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);

        var child = result.Select(u => u.RawRepresentation)
            .OfType<SubagentStartedEvent>()
            .Single(e => e.SubagentRunId == "child");
        Assert.Equal("a", child.ParentSubagentRunId);

        // Each lane's messages keep their own attribution despite the interleaved
        // lifecycle. TEXT_MESSAGE_START and _END are consumed by TextMessageBuilder, so
        // TEXT_MESSAGE_CONTENT is what surfaces and carries the attribution through.
        Assert.Contains(result, u => u.RawRepresentation is TextMessageContentEvent { MessageId: "mb", SubagentRunId: "b" });
        Assert.Contains(result, u => u.RawRepresentation is TextMessageContentEvent { MessageId: "mc", SubagentRunId: "child" });
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_ClosingParentBeforeChild_IsAccepted_ChildStillBlocksRunFinish()
    {
        // Closing order is not constrained — nesting is an identity link, not a stack — but
        // every subagent must still be closed before the run ends.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "a", Name = "alpha" },
            new SubagentStartedEvent { SubagentRunId = "child", Name = "inner", ParentSubagentRunId = "a" },
            new SubagentFinishedEvent { SubagentRunId = "a" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        // The subagent-specific message, not the shared "still active" wording the step and
        // text-message guards also use: asserting only "child" passed even if the run was
        // rejected for some unrelated reason that happened to name the id.
        Assert.Contains("while subagents are still active", ex.Message, StringComparison.Ordinal);
        Assert.Contains("child", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_AttributedStateEvents_AreAccepted()
    {
        // The protocol design lists STATE_SNAPSHOT / STATE_DELTA as carrying attribution,
        // in the same standalone category as STEP_*, CUSTOM and RAW. Attribution on them
        // is PROVENANCE -- which subagent produced the update -- not ownership; the state
        // stays run-scoped and is applied run-scoped.
        //
        // An earlier revision THREW on these, which made this client stricter than the
        // protocol and would have failed a conforming producer. This test keeps that from
        // coming back, and mirrors the TypeScript verifier's equivalent test so the two
        // SDKs cannot drift on what they accept.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new StateSnapshotEvent { Snapshot = JsonDocument.Parse("{\"a\":1}").RootElement, SubagentRunId = "s1" },
            new StateDeltaEvent { Delta = JsonDocument.Parse("[]").RootElement, SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        await ProcessEventsAsync(events);
    }

    [Fact]
    public async Task Subagent_UnattributedStateFromParent_IsAccepted()
    {
        // The control for the two rejection cases above: state still flows normally while a
        // subagent is running, as long as it is the parent's.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new StateSnapshotEvent { Snapshot = JsonDocument.Parse("{\"a\":1}").RootElement },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<StateSnapshotEvent>());
    }

    [Fact]
    public async Task Subagent_StateIsClearedBetweenRuns()
    {
        // Run-scoped state: a subagent left open by an earlier run must not block the next
        // one, matching how activeSteps resets.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" }
        };

        var result = await ProcessEventsAsync(events);

        // The same subagent id reused in the second run is not a duplicate.
        Assert.Equal(2, result.Select(u => u.RawRepresentation).OfType<SubagentStartedEvent>().Count());
        Assert.Equal(2, result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>().Count());
    }

    [Fact]
    public async Task Subagent_NothingIsAcceptedAfterTheRunTerminal()
    {
        // Exactly one terminal event per run, and nothing after it: a trailing subagent
        // event is rejected by the same guard that rejects any post-terminal event.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunErrorEvent { Message = "failed" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("already errored", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ToolCallAttribution_SurvivesTheWire()
    {
        // Tool calls are the consequential attribution path: their args and result are what
        // travel back to the provider on the next turn.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{\"q\":\"x\"}", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallResultEvent { MessageId = "m9", ToolCallId = "tc1", Content = "done", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var raws = result.Select(u => u.RawRepresentation).ToList();

        // TOOL_CALL_START and TOOL_CALL_ARGS are consumed by ToolCallBuilder, which turns
        // them into FunctionCallContent; END and RESULT pass through, and both must still
        // carry the attribution after the SSE round trip.
        Assert.Contains(raws, r => r is ToolCallEndEvent { SubagentRunId: "s1" });
        Assert.Contains(raws, r => r is ToolCallResultEvent { SubagentRunId: "s1" });
        // The materialised call itself is what travels back to the provider next turn.
        var call = Assert.Single(result.SelectMany(u => u.Contents.OfType<FunctionCallContent>()));
        Assert.Equal("search", call.Name);
    }

    // These mirror verifyEvents in the TypeScript client one-for-one. The criterion is
    // that both SDKs accept or reject the same stream; anywhere only one of them
    // rejects, a producer is validated by one client and not the other.

    [Fact]
    public async Task Subagent_ToolCallArgsWithDifferentOwner_Throws()
    {
        // The consequential half of owner-mismatch: a tool call's args and result are
        // what travel back to the provider next turn, so stitching a subagent's call
        // onto another owner's is how a wrong call reaches the model.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ToolCallEndWithDifferentOwner_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_TextMessageContentWithDifferentOwner_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "x", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_UntaggedContinuationOfATaggedOpener_IsAccepted()
    {
        // Omitting the tag is not a disagreement — attribution is optional per event —
        // so producers that tag only openers stay valid in both SDKs.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_RestartingAFinishedSubagent_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("already finished in this run", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_EventTaggedWithAFinishedSubagent_IsAccepted()
    {
        // Pins a deliberate design decision, matching TypeScript. The rule is that a
        // continuation must not DISAGREE with its opener; requiring a tag to name a
        // still-live subagent was explicitly rejected so attribution-only producers stay
        // valid. Tightening it here would make .NET stricter than TypeScript — the exact
        // divergence this file exists to prevent.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "trailing" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_MissingRequiredIdentifier_Throws()
    {
        // TypeScript rejects this via zod. System.Text.Json has no equivalent, so a
        // missing property arrives as string.Empty — which would otherwise register an
        // active subagent named "" and corrupt the validation state.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { Name = "worker" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("'subagentRunId' is required", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_MissingRequiredName_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("'name' is required", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_MissingErrorMessage_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new SubagentErrorEvent { SubagentRunId = "s1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("'message' is required", ex.Message, StringComparison.Ordinal);
    }

    // The owner maps are per run, and each has its own reset line. An opener that rejects a
    // second, disagreeing opener only stays correct while that reset holds: a stale entry
    // would make the next run's legitimate opener look like a contradiction. One test per
    // map, because a dropped Clear() is a one-line regression.
    //
    // (The closed-subagent set's own per-run coverage lives in
    // Subagent_StateIsClearedBetweenRuns, which drives the identical stream.)

    [Fact]
    public async Task Subagent_ReasoningOwnersAreClearedBetweenRuns()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningEndEvent { MessageId = "r1", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            // Same reasoning id, different subagent: a new run, so not a contradiction.
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s2" },
            new ReasoningEndEvent { MessageId = "r1", SubagentRunId = "s2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Equal(2, result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>().Count());
    }

    [Fact]
    public async Task Subagent_ToolCallOwnersAreClearedBetweenRuns()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s2" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Equal(2, result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>().Count());
    }

    [Fact]
    public async Task Subagent_ActivityOwnersAreClearedBetweenRuns()
    {
        // The second run's snapshot deliberately does NOT replace, so it takes no ownership
        // of its own: only a cleared map lets its delta through.
        var content = JsonDocument.Parse("{}").RootElement;
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, Replace = false, SubagentRunId = "s2" },
            new ActivityDeltaEvent { MessageId = "a1", ActivityType = "search", Patch = JsonDocument.Parse("[]").RootElement, SubagentRunId = "s2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Equal(2, result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>().Count());
    }

    [Fact]
    public async Task Subagent_ResponseMessages_CarryAttributionAcrossATurn()
    {
        // The full loop: GetResponseAsync builds its response from these updates via
        // ToChatResponse (never AsChatMessages), so anything not stamped here comes back
        // untagged and the next turn sends it to the agent as the parent's. Tool-call
        // updates are the ones that broke: ToolCallBuilder emits them with a null
        // MessageId, so keying on MessageId alone missed them entirely.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "found it", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);

        // Text and tool-call updates both carry it.
        Assert.Contains(updates, u => u.Text is { Length: > 0 } && Owner(u) == "s1");
        Assert.Contains(
            updates,
            u => u.Contents.OfType<FunctionCallContent>().Any() && Owner(u) == "s1");

        // And it survives coalescing into the response, then back out to AG-UI messages —
        // which is what the next turn actually sends.
        var response = updates.ToChatResponse();
        var roundTripped = response.Messages
            .AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)
            .ToList();
        Assert.All(
            roundTripped.Where(m => m.Role is "assistant" or "tool"),
            m => Assert.Equal("s1", m.SubagentRunId));
    }

    [Fact]
    public async Task Subagent_AttributionOnlyOutput_SurvivesCoalescingWithoutATextMessage()
    {
        // The round-trip above interleaves a text message, so the id-less tool updates
        // joined a message that already carried the owner. A delegation whose visible
        // output is ONLY tool activity has no text update to ride on: every update has a
        // null MessageId, the coalescer hoists their AdditionalProperties to the
        // ChatResponse, and AsAGUIMessages reads attribution per message — so the next
        // turn sent the subagent's work back as the parent's.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallResultEvent { MessageId = "tr1", ToolCallId = "tc1", Content = "42", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);

        var response = updates.ToChatResponse();
        var roundTripped = response.Messages
            .AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)
            .ToList();

        var attributable = roundTripped
            .Where(m => m is AGUIAssistantMessage { ToolCalls.Count: > 0 } or AGUIToolMessage)
            .ToList();
        Assert.NotEmpty(attributable);
        Assert.All(attributable, m => Assert.Equal("s1", m.SubagentRunId));
    }

    [Fact]
    public async Task EmptyStringParentMessageId_MintsTheToolCallId()
    {
        // The TypeScript reducer's parent fallback is a TRUTHINESS check, so an
        // empty-string parentMessageId — which this SDK's own server emits for
        // unset optionals on some paths — mints the toolCallId there. Keeping ""
        // here put an empty messageId on the update and split the coalesced
        // message (caught by the hosting baseline snapshots).
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", ParentMessageId = "" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new ToolCallResultEvent { MessageId = "tc1", ToolCallId = "tc1", Content = "done" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        var callUpdate = Assert.Single(updates, u => u.Contents.OfType<FunctionCallContent>().Any());
        Assert.Equal("tc1", callUpdate.MessageId);
    }

    [Fact]
    public async Task Subagent_EncryptedOnlyReasoning_SurvivesCoalescing()
    {
        // Same coalescer rule as the attribution-only case above: an encrypted
        // reasoning value is the ONLY content some providers stream for a reasoning
        // step, its update carried no MessageId, and the round trip came back
        // parent-owned.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new ReasoningMessageStartEvent { MessageId = "r1", Role = "reasoning", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent { EntityId = "r1", EncryptedValue = "opaque", SubagentRunId = "s1" },
            new ReasoningMessageEndEvent { MessageId = "r1", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        var response = updates.ToChatResponse();
        var roundTripped = response.Messages
            .AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)
            .ToList();

        // The encrypted-only update coalesces into an assistant message (the reverse
        // mapping has no reasoning-message case for protected-data-only content) — the
        // owner must ride it regardless of the shape it lands in.
        var assistant = roundTripped.OfType<AGUIAssistantMessage>().ToList();
        Assert.NotEmpty(assistant);
        Assert.All(assistant, m => Assert.Equal("s1", m.SubagentRunId));
    }

    [Fact]
    public async Task Subagent_InterruptedToolCall_ApprovalKeepsAttributionAcrossTheTurn()
    {
        // FlushWithInterrupts replaces the buffered call update with a
        // ToolApprovalRequestContent update; dropping the buffered update's message
        // identity re-opened the coalescer hole for exactly the HITL turn where
        // attribution matters most.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "dangerous", SubagentRunId = "s1" },
            new ToolCallArgsEvent { ToolCallId = "tc1", Delta = "{}", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new SubagentFinishedEvent
            {
                SubagentRunId = "s1",
                Outcome = new SubagentFinishedSuspendedOutcome { InterruptIds = ["int-1"] }
            },
            new RunFinishedEvent
            {
                ThreadId = "t1",
                RunId = "r1",
                Outcome = new RunFinishedInterruptOutcome
                {
                    Interrupts =
                    {
                        new AGUIInterrupt
                        {
                            Id = "int-1",
                            Reason = InterruptReasons.ToolCall,
                            ToolCallId = "tc1",
                            SubagentRunId = "s1"
                        }
                    }
                }
            }
        };

        var updates = await ProcessEventsAsync(events);

        var approvalUpdate = Assert.Single(
            updates, u => u.Contents.OfType<ToolApprovalRequestContent>().Any());
        Assert.Equal("s1", Owner(approvalUpdate));
        Assert.NotNull(approvalUpdate.MessageId);

        var response = updates.ToChatResponse();
        var roundTripped = response.Messages
            .AsAGUIMessages(AGUIJsonSerializerContext.Default.Options)
            .ToList();
        // The approval content maps back to an assistant message; whatever shape it
        // lands in, the subagent's ownership must survive the turn.
        var assistant = roundTripped.OfType<AGUIAssistantMessage>().ToList();
        Assert.NotEmpty(assistant);
        Assert.All(assistant, m => Assert.Equal("s1", m.SubagentRunId));
    }

    [Fact]
    public async Task Subagent_CallIdReuseAcrossRuns_DoesNotInheritTheEarlierRunsMessage()
    {
        // Minted message identities are per run: entity ids are run-global, so a
        // second run may reference tc1 WITHOUT restarting it (an attribution-only
        // encrypted value). A restart overwrites the stale entry, so the leak shows
        // only on this shape: the stale lookup handed run two's value run ONE's
        // parent message identity.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", ParentMessageId = "run1-msg" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new ToolCallResultEvent { MessageId = "tr1", ToolCallId = "tc1", Content = "done" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "researcher" },
            new ReasoningEncryptedValueEvent
            {
                Subtype = "tool-call",
                EntityId = "tc1",
                EncryptedValue = "opaque",
                SubagentRunId = "s1"
            },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" }
        };

        var updates = await ProcessEventsAsync(events);

        var encryptedUpdate = Assert.Single(
            updates,
            u => u.Contents.OfType<TextReasoningContent>().Any(c => c.ProtectedData is not null));
        // Run two never minted a message for tc1, so the fallback is the call id
        // itself — never run one's "run1-msg". (Owner resolution is out of scope
        // here: nothing in run two recorded an owner for tc1, so this update
        // resolves to none — the pin is the message identity, not attribution.)
        Assert.Equal("tc1", encryptedUpdate.MessageId);
    }

    [Fact]
    public async Task Parent_ResponseMessages_StayUnattributed()
    {
        // Control: an unattributed run must not acquire the key.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        Assert.All(updates, u => Assert.Null(Owner(u)));
    }

    [Fact]
    public async Task Subagent_ReasoningContinuationWithDifferentOwner_Throws()
    {
        // Parity: TypeScript rejects this, so .NET must too.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageStartEvent { MessageId = "r1", Role = "reasoning", SubagentRunId = "s1" },
            new ReasoningMessageContentEvent { MessageId = "r1", Delta = "x", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ToolCallEncryptedValueWithDifferentOwner_Throws()
    {
        // `subtype` decides which entity is continued; a "tool-call" value belongs to the
        // tool call, not a reasoning message.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent
            {
                Subtype = "tool-call",
                EntityId = "tc1",
                EncryptedValue = "opaque",
                SubagentRunId = "s2"
            }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ChildOfAFinishedParent_IsAccepted()
    {
        // parentSubagentRunId must have been STARTED, not still be active.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "p", Name = "parent" },
            new SubagentFinishedEvent { SubagentRunId = "p" },
            new SubagentStartedEvent { SubagentRunId = "c", Name = "child", ParentSubagentRunId = "p" },
            new SubagentFinishedEvent { SubagentRunId = "c" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_NonReplacingActivitySnapshot_DoesNotTakeOwnership()
    {
        var content = JsonDocument.Parse("{}").RootElement;
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, Replace = false, SubagentRunId = "s1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, Replace = false, SubagentRunId = "s2" },
            new ActivityDeltaEvent { MessageId = "a1", ActivityType = "search", Patch = JsonDocument.Parse("[]").RootElement, SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_OpenerOnlyAttribution_ReachesTheResponse()
    {
        // TEXT_MESSAGE_START yields no update, so deriving owners from updates alone never
        // saw it and an opener-only stream came back unattributed.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        Assert.Contains(updates, u => u.Text is { Length: > 0 } && Owner(u) == "s1");
    }

    [Fact]
    public async Task Subagent_UntaggedToolResult_IsParentOwned()
    {
        // TOOL_CALL_RESULT carries its own attribution — the executor can differ from the
        // caller — so an untagged one belongs to the parent, and the tool message it mints
        // must not inherit the call's subagent.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallResultEvent { MessageId = "m9", ToolCallId = "tc1", Content = "done" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        var resultUpdate = Assert.Single(
            updates, u => u.Contents.OfType<FunctionResultContent>().Any());
        Assert.Null(Owner(resultUpdate));
    }

    [Fact]
    public async Task Subagent_OwnershipDoesNotLeakBetweenRuns()
    {
        // Run 2 reuses the message id for a parent-owned message; the stamp must not carry
        // run 1's owner across.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "from s1" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "from the parent" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" }
        };

        var updates = await ProcessEventsAsync(events);
        var secondRunText = updates.Last(u => u.Text == "from the parent");
        Assert.Null(Owner(secondRunText));
    }

    [Fact]
    public async Task Subagent_ToolResultOwner_DoesNotRestampTheCall()
    {
        // TOOL_CALL_RESULT carries its own attribution so the executor can differ from
        // the caller. It therefore owns only the minted tool message; writing it onto the
        // call restamped the buffered FunctionCallContent and lost the caller's owner.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallResultEvent { MessageId = "m9", ToolCallId = "tc1", Content = "done" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        var callUpdate = Assert.Single(updates, u => u.Contents.OfType<FunctionCallContent>().Any());
        Assert.Equal("s1", Owner(callUpdate));
    }

    [Fact]
    public async Task Subagent_ActivitySnapshotWithoutReplace_DefaultsToReplacing()
    {
        // The schemas default `replace` to true, so an omitted value means the snapshot
        // re-mints (and re-owns) the activity. Treating null as false rejected a stream
        // TypeScript accepts.
        var content = JsonDocument.Parse("{}").RootElement;
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, SubagentRunId = "s1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, SubagentRunId = "s2" },
            new ActivityDeltaEvent { MessageId = "a1", ActivityType = "search", Patch = JsonDocument.Parse("[]").RootElement, SubagentRunId = "s2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_ReasoningStartIsAnOpener()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningEndEvent { MessageId = "r1", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_SecondReasoningOpenerThatContradictsTheFirst_Throws()
    {
        // The recorded owner stayed the first subagent's while the minted message was
        // restamped with the second's, so the converter's own state disagreed with
        // itself. TypeScript rejects the same shape.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageStartEvent { MessageId = "r1", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_SecondReasoningOpenerThatAgrees_IsAccepted()
    {
        // The usual pair: REASONING_START brackets the outer reasoning and
        // REASONING_MESSAGE_START the inner message under the same id and owner.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageEndEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningEndEvent { MessageId = "r1", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.NotEmpty(result);
    }

    [Fact]
    public async Task Subagent_SecondUntaggedReasoningOpener_IsAccepted()
    {
        // An absent tag is never a disagreement -- producers that tag only the outer
        // bracket keep working. And "accepted" is not enough: the second opener must also
        // leave the RESOLUTION map alone. Recording its owner unconditionally restamped
        // r1 as parent-owned while the validation map still said s1, so the two maps
        // contradicted each other and the reasoning content came back unattributed.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageStartEvent { MessageId = "r1" },
            new ReasoningMessageContentEvent { MessageId = "r1", Delta = "thinking" },
            new ReasoningMessageEndEvent { MessageId = "r1" },
            new ReasoningEndEvent { MessageId = "r1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var reasoning = Assert.Single(result, u => u.RawRepresentation is ReasoningMessageContentEvent);
        Assert.Equal("s1", Owner(reasoning));
    }

    [Fact]
    public async Task Subagent_CompactReasoningChunkOwnerChange_Throws()
    {
        // The one compact stream this SDK models; TypeScript's chunk transform rejects the
        // same disagreement.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "r1", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { MessageId = "r1", Delta = "b", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ConcurrentCompactReasoningStreams_AreTrackedPerLane()
    {
        // Two subagents stream compact reasoning at once. The open-stream cursor is PER
        // LANE, so an id-less chunk continues the stream of the subagent that tagged it —
        // not whichever stream happened to open last. One cursor for the whole run compared
        // s1's continuation against rb, which s2 owns, and rejected a stream TypeScript's
        // chunk transform accepts: it resolves the lane from the tag first.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "ra", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { MessageId = "rb", Delta = "b", SubagentRunId = "s2" },
            new ReasoningMessageChunkEvent { Delta = "c", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_IdlessCompactChunk_IsCheckedAgainstItsOwnLaneOnly()
    {
        // s1 re-opens with a NEW id, which moves only s1's cursor; s2's id-less
        // continuation is still measured against s2's own open stream. A single cursor
        // pointed at rc, so s2's chunk was rejected for disagreeing with s1.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "ra", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { MessageId = "rb", Delta = "b", SubagentRunId = "s2" },
            new ReasoningMessageChunkEvent { MessageId = "rc", Delta = "c", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { Delta = "d", SubagentRunId = "s2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_UntaggedIdlessCompactChunk_IsNeverAMismatch()
    {
        // A null tag cannot disagree with anyone, so an untagged continuation is accepted
        // whichever lane is open — here only a subagent's is.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "ra", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { Delta = "b" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_CompactReasoningCursorsAreClearedBetweenRuns()
    {
        // The cursors are per-run state like the owner maps: run 2's id-less chunk must not
        // be checked against the stream run 1 left open.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "r1", Delta = "a", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" },
            new RunStartedEvent { ThreadId = "t1", RunId = "r2" },
            new ReasoningMessageChunkEvent { Delta = "b", SubagentRunId = "s2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r2" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Equal(2, result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>().Count());
    }

    // Text messages and tool calls get the same first-writer + disagreement rule the
    // reasoning openers have. Their openers used to overwrite unconditionally, so a closed
    // id reopened by a DIFFERENT subagent was accepted and silently re-owned — and for a
    // tool call that is the consequential direction, since the re-owned args and result are
    // what travel back to the provider on the next turn.

    [Fact]
    public async Task Subagent_TextMessageReopenedUnderADifferentOwner_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "from s1", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ToolCallReopenedUnderADifferentOwner_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_ReopeningAnIdUnderTheSameOwner_IsAccepted()
    {
        // The control: agreeing with the recorded owner is no contradiction, for either
        // entity kind.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "again", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.Single(result.Select(u => u.RawRepresentation).OfType<RunFinishedEvent>());
    }

    [Fact]
    public async Task Subagent_UntaggedReopen_DoesNotClearTheRecordedOwner()
    {
        // An absent tag is not a disagreement, so the reopen is accepted — but it must not
        // overwrite either: the recorded owner stays s1, so a later s1-tagged continuation
        // still agrees and the message keeps its attribution.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "still s1", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var text = Assert.Single(result, u => u.Text == "still s1");
        Assert.Equal("s1", Owner(text));
    }

    [Fact]
    public async Task Subagent_TaggedContinuationOfAnUntaggedOpener_Throws()
    {
        // The null -> tag direction: the parent owns m1, and the parent is as much an owner
        // as a subagent, so a tagged continuation on it is a disagreement. Only the ABSENCE
        // of a recorded owner means "unknown opener".
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant" },
            new TextMessageContentEvent { MessageId = "m1", Delta = "x", SubagentRunId = "s1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_EncryptedToolCallValueAfterTheCallClosed_IsStillChecked()
    {
        // Nothing requires the encrypted continuation to arrive before TOOL_CALL_END, so
        // the owner has to remain available after the close.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent
            {
                Subtype = "tool-call",
                EntityId = "tc1",
                EncryptedValue = "opaque",
                SubagentRunId = "s2"
            }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_EncryptedMessageValueOnAReasoningMessage_IsStillChecked()
    {
        // Subtype "message" may name a REASONING message, whose owner lives in
        // reasoningOwners — checking messageOwners alone found nothing there and
        // accepted a foreign tag. TypeScript had the identical gap.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageEndEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent
            {
                Subtype = "message",
                EntityId = "r1",
                EncryptedValue = "opaque",
                SubagentRunId = "s2"
            }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_EncryptedMessageValueOnAReasoningMessage_AcceptsTheOwner()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageStartEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningMessageEndEvent { MessageId = "r1", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent
            {
                Subtype = "message",
                EntityId = "r1",
                EncryptedValue = "opaque",
                SubagentRunId = "s1"
            },
            new ReasoningEndEvent { MessageId = "r1", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.NotEmpty(result);
    }

    [Fact]
    public async Task Subagent_EmptyMessageId_StillCarriesAttribution()
    {
        // An empty messageId is a valid string per the schemas, and the builders accept it.
        // Skipping empty ids when recording owners lost the attribution, so the response
        // came back parent-owned while TypeScript preserved it.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "", Delta = "hi" },
            new TextMessageEndEvent { MessageId = "" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        Assert.Contains(updates, u => u.Text is { Length: > 0 } && Owner(u) == "s1");
    }

    [Fact]
    public async Task Subagent_CompactReasoningChunkWithEmptyId_StillChecksOwner()
    {
        // The last instance of the same rule: an empty messageId is present, not absent,
        // so the compact stream's owner is registered and a mismatched continuation is
        // rejected — as TypeScript's transform already does.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { MessageId = "", Delta = "b", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_BufferedUpdates_KeepTheOwnerTheyHadAtCreation()
    {
        // Updates produced while a tool call is buffering are flushed later, after further
        // events have moved the owner map on. Resolving at flush time stamped the earlier
        // update with the later owner, so the first activity — genuinely s1's — was
        // reported as s2's.
        var content = JsonDocument.Parse("{}").RootElement;
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            // Open a tool call so subsequent pass-through updates are buffered.
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, Replace = true, SubagentRunId = "s1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, Replace = true, SubagentRunId = "s2" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        var activityUpdates = updates
            .Where(u => u.RawRepresentation is ActivitySnapshotEvent)
            .ToList();

        Assert.Equal(2, activityUpdates.Count);
        Assert.Equal("s1", Owner(activityUpdates[0]));
        Assert.Equal("s2", Owner(activityUpdates[1]));
    }

    [Fact]
    public async Task Subagent_BufferedParentOwnedUpdate_StaysParentOwned()
    {
        // The residual of freezing owners at creation: a marker was written only when an
        // owner was FOUND, so a parent-owned buffered update got none and was re-resolved
        // at flush — after s1 had taken the activity over — and the parent's snapshot came
        // out as s1's. "Resolved to the parent" is a different state from "unresolved".
        var content = JsonDocument.Parse("{}").RootElement;
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search" },
            new ToolCallEndEvent { ToolCallId = "tc1" },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, Replace = true },
            new ActivitySnapshotEvent { MessageId = "a1", ActivityType = "search", Content = content, Replace = true, SubagentRunId = "s1" },
            new ToolCallResultEvent { MessageId = "m9", ToolCallId = "tc1", Content = "done" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        var activityUpdates = updates
            .Where(u => u.RawRepresentation is ActivitySnapshotEvent)
            .ToList();

        Assert.Equal(2, activityUpdates.Count);
        Assert.Null(Owner(activityUpdates[0]));
        Assert.Equal("s1", Owner(activityUpdates[1]));
    }

    [Fact]
    public async Task Subagent_InternalResolutionMarker_NeverReachesTheCaller()
    {
        // The marker is an implementation detail; leaking it would put a stray key on every
        // buffered message's AdditionalProperties.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallResultEvent { MessageId = "m9", ToolCallId = "tc1", Content = "done", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        Assert.All(
            updates,
            u => Assert.False(u.AdditionalProperties?.ContainsKey("agui.__ownerResolved") == true));
    }

    [Fact]
    public async Task Subagent_ResultReusingTheToolCallIdAsMessageId_DoesNotRestampTheCall()
    {
        // ToolCallResultEventExtensions in AGUI.Server emits MessageId == ToolCallId, so
        // this is the DEFAULT shape this SDK produces, not an edge case. With one flat owner
        // map the result's owner overwrote the call's, and the FunctionCallContent — still
        // buffered until the result arrives — flushed with the wrong one. Message ids and
        // tool call ids are separate namespaces.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            // Parent-owned result reusing the call id as its message id.
            new ToolCallResultEvent { MessageId = "tc1", ToolCallId = "tc1", Content = "done" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);

        var callUpdate = Assert.Single(updates, u => u.Contents.OfType<FunctionCallContent>().Any());
        Assert.Equal("s1", Owner(callUpdate));

        var resultUpdate = Assert.Single(updates, u => u.Contents.OfType<FunctionResultContent>().Any());
        Assert.Null(Owner(resultUpdate));
    }

    [Fact]
    public async Task Subagent_ToolCallEncryptedValue_ResolvesViaTheCallNamespace()
    {
        // `subtype` selects the namespace. With the SDK-default MessageId == ToolCallId
        // shape, reading the message namespace returned the RESULT message's owner rather
        // than the call's, so the encrypted update came out attributed to s2.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "tc1", ToolCallName = "search", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc1", SubagentRunId = "s1" },
            new ToolCallResultEvent { MessageId = "tc1", ToolCallId = "tc1", Content = "done", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent
            {
                Subtype = "tool-call",
                EntityId = "tc1",
                EncryptedValue = "opaque",
                SubagentRunId = "s1"
            },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var updates = await ProcessEventsAsync(events);
        var encrypted = Assert.Single(
            updates, u => u.RawRepresentation is ReasoningEncryptedValueEvent);
        Assert.Equal("s1", Owner(encrypted));
    }

    private static string? Owner(ChatResponseUpdate update) =>
        update.AdditionalProperties?.TryGetValue("agui.subagentRunId", out string? v) == true ? v : null;

    // ────────────────────────────────────────────────
    // Helpers — process events through EventStreamConverter.AsChatResponseUpdates
    // ────────────────────────────────────────────────

    // Step ownership. These mirror the TypeScript verifier's tests one for one, from the
    // same real deepagents run a design partner reported: a subagent ran inside the
    // parent's `tools` step and its own inner step was ALSO called `tools`, because a
    // subagent runs the same graph shape and step names come from graph node names.
    //
    // Before steps were owner-keyed this client had it backwards, exactly as the
    // TypeScript one did: it accepted the mis-attributed closes and rejected the correctly
    // nested stream.

    [Fact]
    public async Task Subagent_ParentAndSubagentStepsOfSameName_AreBothAllowed()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "tools" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "alpha" },
            new StepStartedEvent { StepName = "tools", SubagentRunId = "s1" },
            new StepFinishedEvent { StepName = "tools", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new StepFinishedEvent { StepName = "tools" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        await ProcessEventsAsync(events);
    }

    [Fact]
    public async Task Subagent_StepFinishedClosingParentStepUnderSubagentTag_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new StepStartedEvent { StepName = "tools" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "alpha" },
            new StepFinishedEvent { StepName = "tools", SubagentRunId = "s1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("that step is open under the parent agent", ex.Message, StringComparison.Ordinal);
        Assert.Contains("finished by whoever started it", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_StepFinishedClosingSubagentStepUntagged_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "alpha" },
            new StepStartedEvent { StepName = "inner", SubagentRunId = "s1" },
            new StepFinishedEvent { StepName = "inner" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("attributed to the parent agent", ex.Message, StringComparison.Ordinal);
        Assert.Contains("open under subagent 's1'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_UnfinishedSubagentStepAtRunFinished_NamesTheOwner()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "alpha" },
            new StepStartedEvent { StepName = "inner", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("inner (subagent 's1')", ex.Message, StringComparison.Ordinal);
    }

    // Owner-namespace parity with TypeScript, from PR review. .NET already kept separate
    // owner maps per kind, but routed REASONING_ENCRYPTED_VALUE by only two subtypes, so
    // a "message" value was checked against reasoning owners instead of message owners --
    // the inverse of the TypeScript bug, reachable by the same shape.

    [Fact]
    public async Task Subagent_EncryptedMessageValue_ChecksMessageOwners()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "a" },
            new SubagentStartedEvent { SubagentRunId = "s2", Name = "b" },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent { Subtype = "message", EntityId = "m", EncryptedValue = "v", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_EncryptedToolCallValue_StillChecksToolCallOwners()
    {
        // The case that already worked must keep working: routing by subtype must not
        // collapse the three kinds back into two.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "a" },
            new SubagentStartedEvent { SubagentRunId = "s2", Name = "b" },
            new ToolCallStartEvent { ToolCallId = "c", ToolCallName = "t", SubagentRunId = "s1" },
            new ReasoningEncryptedValueEvent { Subtype = "tool-call", EntityId = "c", EncryptedValue = "v", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Subagent_EmptyStringId_IsDistinctFromTheParent()
    {
        // "" is a legal opaque subagent id. .NET keys steps on a (owner, name) tuple so
        // null and "" stay distinct; this pins the parity with TypeScript, which had
        // flattened them into one string and lost the distinction.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "", Name = "a" },
            new StepStartedEvent { StepName = "tools" },
            new StepStartedEvent { StepName = "tools", SubagentRunId = "" },
            new StepFinishedEvent { StepName = "tools", SubagentRunId = "" },
            new StepFinishedEvent { StepName = "tools" },
            new SubagentFinishedEvent { SubagentRunId = "" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        await ProcessEventsAsync(events);
    }

    [Fact]
    public async Task Subagent_AttributionOnlyStream_IsAccepted()
    {
        // Phase-1 attribution without any lifecycle events is deliberately valid, so an id
        // that no SUBAGENT_STARTED ever named must not be rejected. Pinned in both SDKs
        // because a review asked for the opposite and the DOCS were the thing at fault.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "never-started" },
            new TextMessageContentEvent { MessageId = "m", Delta = "x", SubagentRunId = "never-started" },
            new TextMessageEndEvent { MessageId = "m", SubagentRunId = "never-started" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        await ProcessEventsAsync(events);
    }

    // ────────────────────────────────────────────────
    // Ownership seeded from MESSAGES_SNAPSHOT (mirrors verifyEvents)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task Snapshot_ReopenUnderDifferentSubagent_Throws()
    {
        // The replay-corruption door: without seeding, the reopen was accepted and
        // s2's content was appended into s1's message.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new MessagesSnapshotEvent
            {
                Messages = [new AGUIAssistantMessage { Id = "m", Content = "old", SubagentRunId = "s1" }]
            },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Snapshot_ReplayedToolCallUnderDifferentSubagent_Throws()
    {
        // A ToolCall carries no owner field of its own, so it belongs to its message.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new MessagesSnapshotEvent
            {
                Messages =
                [
                    new AGUIAssistantMessage
                    {
                        Id = "m",
                        SubagentRunId = "s1",
                        ToolCalls = [new AGUIToolCall { Id = "tc", Function = new() { Name = "search", Arguments = "{}" } }]
                    }
                ]
            },
            new ToolCallStartEvent { ToolCallId = "tc", ToolCallName = "search", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Snapshot_ReopenMatchingOwner_Succeeds()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new MessagesSnapshotEvent
            {
                Messages = [new AGUIAssistantMessage { Id = "m", Content = "old", SubagentRunId = "s1" }]
            },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageContentEvent { MessageId = "m", Delta = "new", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m", SubagentRunId = "s1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.IsType<RunFinishedEvent>(result[^1].RawRepresentation);
    }

    // ────────────────────────────────────────────────
    // Tool call vs parent message ownership (mirrors verifyEvents)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task ToolCall_OwnerConflictsWithParentMessage_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc", ToolCallName = "search", ParentMessageId = "m", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("parent message 'm'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ToolCall_UntaggedInheritsParentMessageOwner_Succeeds()
    {
        // The untagged call inherits s1 from its parent message, so an s1-tagged
        // continuation agrees with it.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc", ToolCallName = "search", ParentMessageId = "m" },
            new ToolCallArgsEvent { ToolCallId = "tc", Delta = "{}", SubagentRunId = "s1" },
            new ToolCallEndEvent { ToolCallId = "tc" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        Assert.IsType<RunFinishedEvent>(result[^1].RawRepresentation);
    }

    [Fact]
    public async Task ToolCall_ContinuationDisagreesWithInheritedOwner_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc", ToolCallName = "search", ParentMessageId = "m" },
            new ToolCallArgsEvent { ToolCallId = "tc", Delta = "{}", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    // ────────────────────────────────────────────────
    // Ambiguous id-less reasoning chunks (mirrors the TypeScript chunk transform)
    // ────────────────────────────────────────────────

    [Fact]
    public async Task ReasoningChunk_IdlessTaglessWithTwoOpenLanes_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "ra", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { MessageId = "rb", Delta = "b", SubagentRunId = "s2" },
            new ReasoningMessageChunkEvent { Delta = "c" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("Ambiguous", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReasoningChunk_IdlessTaglessSoleOpenLane_ContinuesAndAttributes()
    {
        // With no parent stream open, the sole open lane is the chunk's only possible
        // referent — and an event with no MessageId is otherwise unresolvable, so the
        // inferred owner must be transferred onto the update explicitly.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "ra", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { Delta = "c" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var idless = result.Single(u =>
            u.RawRepresentation is ReasoningMessageChunkEvent { MessageId: null });
        Assert.Equal("s1", idless.AdditionalProperties?[EventStreamConverter.AGUISubagentRunIdKey]);
    }

    [Fact]
    public async Task ReasoningChunk_IdlessTaglessPrefersParentOpenStream()
    {
        // Untagged means the parent, so the parent's own open stream wins over a
        // subagent lane — the update stays unattributed (no owner key).
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "rp", Delta = "p" },
            new ReasoningMessageChunkEvent { MessageId = "ra", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { Delta = "c" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var idless = result.Single(u =>
            u.RawRepresentation is ReasoningMessageChunkEvent { MessageId: null });
        Assert.False(
            idless.AdditionalProperties?.ContainsKey(EventStreamConverter.AGUISubagentRunIdKey) == true,
            "an id-less chunk continuing the parent's stream must not be attributed to a subagent");
    }

    [Fact]
    public async Task RunStartedInputEcho_ReopenUnderDifferentSubagent_Throws()
    {
        // RUN_STARTED.input is replayed history inside the verified stream, so it
        // seeds ownership exactly like a snapshot does.
        var events = new BaseEvent[]
        {
            new RunStartedEvent
            {
                ThreadId = "t1",
                RunId = "r1",
                Input = new RunAgentInput
                {
                    ThreadId = "t1",
                    RunId = "r1",
                    Messages = [new AGUIAssistantMessage { Id = "m", Content = "old", SubagentRunId = "s1" }]
                }
            },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Snapshot_ReasoningMessageSeedsTheReasoningOwnerMap_Throws()
    {
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new MessagesSnapshotEvent
            {
                Messages = [new AGUIReasoningMessage { Id = "r1", Content = "old", SubagentRunId = "s1" }]
            },
            new ReasoningMessageStartEvent { MessageId = "r1", SubagentRunId = "s2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Snapshot_AuthoritativelyReplacesARecordedOwner()
    {
        // The snapshot restates the conversation and the reducer replaces the
        // message, so the OLD owner no longer matches after it.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m", SubagentRunId = "s1" },
            new MessagesSnapshotEvent
            {
                Messages = [new AGUIAssistantMessage { Id = "m", Content = "snapshot", SubagentRunId = "s2" }]
            },
            new TextMessageStartEvent { MessageId = "m", Role = "assistant", SubagentRunId = "s1" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("does not match", ex.Message, StringComparison.Ordinal);
        Assert.Contains("s2", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ToolCall_UntaggedReopenUnderDifferentParent_Throws()
    {
        // Both starts are untagged, but the second start's EFFECTIVE owner is s2
        // (inherited from m2) while the retained owner is s1.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new TextMessageStartEvent { MessageId = "m1", Role = "assistant", SubagentRunId = "s1" },
            new TextMessageEndEvent { MessageId = "m1", SubagentRunId = "s1" },
            new ToolCallStartEvent { ToolCallId = "tc", ToolCallName = "search", ParentMessageId = "m1" },
            new ToolCallEndEvent { ToolCallId = "tc" },
            new TextMessageStartEvent { MessageId = "m2", Role = "assistant", SubagentRunId = "s2" },
            new TextMessageEndEvent { MessageId = "m2", SubagentRunId = "s2" },
            new ToolCallStartEvent { ToolCallId = "tc", ToolCallName = "search", ParentMessageId = "m2" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => ProcessEventsAsync(events));
        Assert.Contains("parent message 'm2'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReasoningChunk_SnapshotClosesTheParentLane_SoleLaneWinsAfterIt()
    {
        // The TypeScript chunk transform closes every lane at MESSAGES_SNAPSHOT;
        // a stale pre-snapshot parent cursor must not win parent-priority and
        // suppress the sole live lane's attribution.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ReasoningMessageChunkEvent { MessageId = "parent", Delta = "p" },
            new MessagesSnapshotEvent { Messages = [] },
            new ReasoningMessageChunkEvent { MessageId = "sub", Delta = "a", SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { Delta = "c" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var idless = result.Single(u =>
            u.RawRepresentation is ReasoningMessageChunkEvent { MessageId: null });
        Assert.Equal("s1", idless.AdditionalProperties?[EventStreamConverter.AGUISubagentRunIdKey]);
    }

    [Fact]
    public async Task ReasoningChunk_SubagentTerminalClosesItsLane()
    {
        // After s1 finishes, its lane is closed: the id-less chunk resolves to the
        // sole remaining open lane (s2), not ambiguity.
        var events = new BaseEvent[]
        {
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new SubagentStartedEvent { SubagentRunId = "s1", Name = "a" },
            new SubagentStartedEvent { SubagentRunId = "s2", Name = "b" },
            new ReasoningMessageChunkEvent { MessageId = "ra", Delta = "a", SubagentRunId = "s1" },
            new SubagentFinishedEvent { SubagentRunId = "s1" },
            new ReasoningMessageChunkEvent { MessageId = "rb", Delta = "b", SubagentRunId = "s2" },
            new ReasoningMessageChunkEvent { Delta = "c" },
            new SubagentFinishedEvent { SubagentRunId = "s2" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" }
        };

        var result = await ProcessEventsAsync(events);
        var idless = result.Single(u =>
            u.RawRepresentation is ReasoningMessageChunkEvent { MessageId: null });
        Assert.Equal("s2", idless.AdditionalProperties?[EventStreamConverter.AGUISubagentRunIdKey]);
    }

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
