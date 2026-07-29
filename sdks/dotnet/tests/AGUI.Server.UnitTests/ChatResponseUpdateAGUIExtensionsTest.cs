using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class ChatResponseUpdateAGUIExtensionsTest
{
    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;

    private const string ThreadId = "thread-1";
    private const string RunId = "run-1";

    #region Run Lifecycle

    [Fact]
    public async Task EmptyStream_EmitsRunStartedAndRunFinished()
    {
        var updates = ToAsyncEnumerable(Array.Empty<ChatResponseUpdate>());

        var events = await CollectEvents(updates);

        Assert.Collection(events,
            e =>
            {
                var started = Assert.IsType<RunStartedEvent>(e);
                Assert.Equal(ThreadId, started.ThreadId);
                Assert.Equal(RunId, started.RunId);
            },
            e =>
            {
                var finished = Assert.IsType<RunFinishedEvent>(e);
                Assert.Equal(ThreadId, finished.ThreadId);
                Assert.Equal(RunId, finished.RunId);
                Assert.IsType<RunFinishedSuccessOutcome>(finished.Outcome);
            });
    }

    [Fact]
    public async Task RunStartedEvent_EmittedAutomatically_BeforeFirstContent()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hello"));

        var events = await CollectEvents(updates);

        Assert.IsType<RunStartedEvent>(events[0]);
    }

    [Fact]
    public async Task RunFinishedEvent_EmittedAutomatically_AfterLastContent()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hello"));

        var events = await CollectEvents(updates);

        Assert.IsType<RunFinishedEvent>(events[^1]);
    }

    [Fact]
    public async Task RunFinishedEvent_NotDuplicated_WhenExplicitlyProvided()
    {
        var explicitFinished = new RunFinishedEvent { ThreadId = ThreadId, RunId = RunId };
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate { RawRepresentation = explicitFinished });

        var events = await CollectEvents(updates);

        var finishedEvents = events.OfType<RunFinishedEvent>().ToList();
        Assert.Single(finishedEvents);
        Assert.Same(explicitFinished, finishedEvents[0]);
    }

    [Fact]
    public async Task RunStartedEvent_NotDuplicated_WhenExplicitlyProvided()
    {
        var explicitStarted = new RunStartedEvent { ThreadId = ThreadId, RunId = RunId };
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate { RawRepresentation = explicitStarted },
            new ChatResponseUpdate(ChatRole.Assistant, "Hello"));

        var events = await CollectEvents(updates);

        var startedEvents = events.OfType<RunStartedEvent>().ToList();
        Assert.Single(startedEvents);
        Assert.Same(explicitStarted, startedEvents[0]);
    }

    [Fact]
    public async Task ExplicitRunStartedEvent_PassedThrough_Directly()
    {
        var explicitStarted = new RunStartedEvent
        {
            ThreadId = "custom-thread",
            RunId = "custom-run",
            ParentRunId = "parent-run"
        };
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate { RawRepresentation = explicitStarted });

        var events = await CollectEvents(updates);

        var started = Assert.IsType<RunStartedEvent>(events[0]);
        Assert.Equal("custom-thread", started.ThreadId);
        Assert.Equal("custom-run", started.RunId);
        Assert.Equal("parent-run", started.ParentRunId);
    }

    #endregion

    #region Text Streaming

    [Fact]
    public async Task SingleTextUpdate_EmitsStart_Content_End()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hello")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        // RunStarted, TextMessageStart, TextMessageContent, TextMessageEnd, RunFinished
        Assert.Equal(5, events.Count);
        var start = Assert.IsType<TextMessageStartEvent>(events[1]);
        Assert.Equal("msg-1", start.MessageId);
        Assert.Equal(AGUIRoles.Assistant, start.Role);

        var content = Assert.IsType<TextMessageContentEvent>(events[2]);
        Assert.Equal("msg-1", content.MessageId);
        Assert.Equal("Hello", content.Delta);

        var end = Assert.IsType<TextMessageEndEvent>(events[3]);
        Assert.Equal("msg-1", end.MessageId);
    }

    [Fact]
    public async Task MultipleTextUpdates_SameMessageId_DoNotReStart()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hello ")
            {
                MessageId = "msg-1"
            },
            new ChatResponseUpdate(ChatRole.Assistant, "World")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        // RunStarted, TextMessageStart, TextContent, TextContent, TextMessageEnd, RunFinished
        Assert.Equal(6, events.Count);

        // Only one TextMessageStart
        var starts = events.OfType<TextMessageStartEvent>().ToList();
        Assert.Single(starts);

        // Two content events
        var contents = events.OfType<TextMessageContentEvent>().ToList();
        Assert.Equal(2, contents.Count);
        Assert.Equal("Hello ", contents[0].Delta);
        Assert.Equal("World", contents[1].Delta);
    }

    [Fact]
    public async Task DifferentMessageIds_EmitsEndThenStartForNewMessage()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "First")
            {
                MessageId = "msg-1"
            },
            new ChatResponseUpdate(ChatRole.Assistant, "Second")
            {
                MessageId = "msg-2"
            });

        var events = await CollectEvents(updates);

        // RunStarted, Start(msg-1), Content(msg-1), End(msg-1), Start(msg-2), Content(msg-2), End(msg-2), RunFinished
        Assert.Equal(8, events.Count);

        var end1 = Assert.IsType<TextMessageEndEvent>(events[3]);
        Assert.Equal("msg-1", end1.MessageId);

        var start2 = Assert.IsType<TextMessageStartEvent>(events[4]);
        Assert.Equal("msg-2", start2.MessageId);
    }

    [Fact]
    public async Task TextUpdate_WithNoMessageId_GeneratesMessageId()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hello"));

        var events = await CollectEvents(updates);

        var start = events.OfType<TextMessageStartEvent>().Single();
        Assert.NotNull(start.MessageId);
        Assert.StartsWith("msg_", start.MessageId);
    }

    [Fact]
    public async Task TextUpdate_EmptyTextContent_SkipsContentEvent()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        // Should have RunStarted, TextMessageStart (still starts because Contents[0] is TextContent),
        // NO TextMessageContent (because text is empty), TextMessageEnd, RunFinished
        Assert.DoesNotContain(events, e => e is TextMessageContentEvent);
    }

    [Fact]
    public async Task AuthorName_IncludedInTextStart()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hi")
            {
                MessageId = "msg-1",
                AuthorName = "agent-1"
            });

        var events = await CollectEvents(updates);

        var start = events.OfType<TextMessageStartEvent>().Single();
        Assert.Equal("agent-1", start.Name);
    }

    #endregion

    #region Reasoning

    [Fact]
    public async Task ReasoningThenText_SharingProviderMessageId_EmitDistinctMessageIds()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("thinking")]
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("") { ProtectedData = "signed-blob" }]
            },
            new ChatResponseUpdate(ChatRole.Assistant, "visible answer")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        var reasoningStartId = events.OfType<ReasoningStartEvent>().Single().MessageId;
        var reasoningMessageStartId = events.OfType<ReasoningMessageStartEvent>().Single().MessageId;
        var textMessageId = events.OfType<TextMessageStartEvent>().Single().MessageId;
        Assert.NotEqual(reasoningStartId, textMessageId);
        Assert.NotEqual(reasoningMessageStartId, textMessageId);
        Assert.Equal(reasoningMessageStartId, events.OfType<ReasoningMessageContentEvent>().Single().MessageId);
        Assert.Equal(reasoningMessageStartId, events.OfType<ReasoningMessageEndEvent>().Single().MessageId);
        Assert.Equal(reasoningMessageStartId, events.OfType<ReasoningEncryptedValueEvent>().Single().EntityId);
    }

    [Fact]
    public async Task ReasoningDeltas_AcrossUpdates_ShareOneReasoningMessageId()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("first ")]
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("second")]
            });

        var events = await CollectEvents(updates);

        var reasoningMessageId = events.OfType<ReasoningMessageStartEvent>().Single().MessageId;
        Assert.All(
            events.OfType<ReasoningMessageContentEvent>(),
            e => Assert.Equal(reasoningMessageId, e.MessageId));
    }

    [Fact]
    public async Task ReasoningBlocks_SeparatedByText_GetDistinctReasoningMessageIds()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("first block")]
            },
            new ChatResponseUpdate(ChatRole.Assistant, "interlude")
            {
                MessageId = "msg-1"
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("second block")]
            });

        var events = await CollectEvents(updates);

        var reasoningIds = events.OfType<ReasoningMessageStartEvent>().Select(e => e.MessageId).ToList();
        Assert.Equal(2, reasoningIds.Count);
        Assert.NotEqual(reasoningIds[0], reasoningIds[1]);
    }

    [Fact]
    public async Task ProtectedData_ArrivingWhileReasoningMessageOpen_BindsEntityIdToReasoningMessage()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("thinking")]
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("") { ProtectedData = "signed-blob" }]
            });

        var events = await CollectEvents(updates);

        var reasoningMessageId = events.OfType<ReasoningMessageStartEvent>().Single().MessageId;
        var encrypted = events.OfType<ReasoningEncryptedValueEvent>().Single();
        Assert.Equal(reasoningMessageId, encrypted.EntityId);
    }

    [Fact]
    public async Task ProtectedData_ArrivingBeforeReasoningMessageOpens_BindsEntityIdToReasoningMessage()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("") { ProtectedData = "signed-blob" }]
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                MessageId = "msg-1",
                Contents = [new TextReasoningContent("thinking")]
            },
            new ChatResponseUpdate(ChatRole.Assistant, "hello")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        var encryptedEntityId = events.OfType<ReasoningEncryptedValueEvent>().Single().EntityId;
        var reasoningMessageId = events.OfType<ReasoningMessageStartEvent>().Single().MessageId;
        var textMessageId = events.OfType<TextMessageStartEvent>().Single().MessageId;

        Assert.Equal(reasoningMessageId, encryptedEntityId);
        Assert.NotEqual(textMessageId, encryptedEntityId);
    }

    #endregion

    #region Role Mapping

    [Theory]
    [InlineData("assistant")]
    [InlineData("user")]
    [InlineData("system")]
    [InlineData("tool")]
    public async Task KnownRoles_MappedCorrectly(string expectedRole)
    {
        var chatRole = expectedRole switch
        {
            "assistant" => ChatRole.Assistant,
            "user" => ChatRole.User,
            "system" => ChatRole.System,
            "tool" => ChatRole.Tool,
            _ => throw new ArgumentException($"Unexpected role: {expectedRole}", nameof(expectedRole))
        };

        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(chatRole, "text")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        var start = events.OfType<TextMessageStartEvent>().Single();
        Assert.Equal(expectedRole, start.Role);
    }

    [Fact]
    public async Task NullRole_DefaultsToAssistant()
    {
        var update = new ChatResponseUpdate { Contents = [new TextContent("text")], MessageId = "msg-1" };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var start = events.OfType<TextMessageStartEvent>().Single();
        Assert.Equal(AGUIRoles.Assistant, start.Role);
    }

    [Fact]
    public async Task CustomRole_MappedToLowercase()
    {
        var update = new ChatResponseUpdate(new ChatRole("Developer"), "text")
        {
            MessageId = "msg-1"
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var start = events.OfType<TextMessageStartEvent>().Single();
        Assert.Equal("developer", start.Role);
    }

    [Fact]
    public async Task DeveloperRole_MappedToAGUIRolesDeveloper()
    {
        var update = new ChatResponseUpdate(new ChatRole("Developer"), "text")
        {
            MessageId = "msg-1"
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var start = events.OfType<TextMessageStartEvent>().Single();
        Assert.Equal(AGUIRoles.Developer, start.Role);
    }

    #endregion

    #region Tool Calls

    [Fact]
    public async Task FunctionCallContent_EmitsToolCallStartArgsEnd()
    {
        var fcc = new FunctionCallContent("call-1", "get_weather",
            new Dictionary<string, object?> { ["city"] = "Seattle" });

        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [fcc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var toolStart = events.OfType<ToolCallStartEvent>().Single();
        Assert.Equal("call-1", toolStart.ToolCallId);
        Assert.Equal("get_weather", toolStart.ToolCallName);

        var toolArgs = events.OfType<ToolCallArgsEvent>().Single();
        Assert.Equal("call-1", toolArgs.ToolCallId);
        Assert.Contains("Seattle", toolArgs.Delta);

        var toolEnd = events.OfType<ToolCallEndEvent>().Single();
        Assert.Equal("call-1", toolEnd.ToolCallId);
    }

    [Fact]
    public async Task FunctionCallContent_SetsParentMessageId()
    {
        var fcc = new FunctionCallContent("call-1", "my_tool");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            MessageId = "parent-msg",
            Contents = [fcc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var toolStart = events.OfType<ToolCallStartEvent>().Single();
        Assert.Equal("parent-msg", toolStart.ParentMessageId);
    }

    [Fact]
    public async Task MultipleFunctionCalls_InSameUpdate_EmitsAllToolCallEvents()
    {
        var fcc1 = new FunctionCallContent("call-1", "tool_a",
            new Dictionary<string, object?> { ["x"] = 1 });
        var fcc2 = new FunctionCallContent("call-2", "tool_b",
            new Dictionary<string, object?> { ["y"] = 2 });

        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [fcc1, fcc2]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var toolStarts = events.OfType<ToolCallStartEvent>().ToList();
        Assert.Equal(2, toolStarts.Count);
        Assert.Equal("call-1", toolStarts[0].ToolCallId);
        Assert.Equal("call-2", toolStarts[1].ToolCallId);
    }

    [Fact]
    public async Task FunctionCallContent_ClosesOpenTextMessage()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "thinking...")
            {
                MessageId = "msg-1"
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents = [new FunctionCallContent("call-1", "my_tool")]
            });

        var events = await CollectEvents(updates);

        // After text content, before tool call start, there should be a TextMessageEnd
        var textEndIndex = events.FindIndex(e => e is TextMessageEndEvent);
        var toolStartIndex = events.FindIndex(e => e is ToolCallStartEvent);

        Assert.True(textEndIndex < toolStartIndex,
            "TextMessageEnd should come before ToolCallStart");

        var textEnd = Assert.IsType<TextMessageEndEvent>(events[textEndIndex]);
        Assert.Equal("msg-1", textEnd.MessageId);
    }

    [Fact]
    public async Task RunFinished_HasSuccessOutcome_WhenToolCallsPresent()
    {
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent("call-1", "my_tool")]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var finished = events.OfType<RunFinishedEvent>().Single();
        Assert.IsType<RunFinishedSuccessOutcome>(finished.Outcome);
    }

    [Fact]
    public async Task RunFinished_HasSuccessOutcome_WhenNoToolCalls()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hello")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        var finished = events.OfType<RunFinishedEvent>().Single();
        Assert.IsType<RunFinishedSuccessOutcome>(finished.Outcome);
    }

    #endregion

    #region Tool Results

    [Fact]
    public async Task FunctionResultContent_EmitsToolCallResultEvent()
    {
        var frc = new FunctionResultContent("call-1", "result-data");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Tool,
            Contents = [frc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var resultEvent = events.OfType<ToolCallResultEvent>().Single();
        Assert.Equal("call-1", resultEvent.ToolCallId);
        Assert.Equal("result-data", resultEvent.Content);
    }

    [Fact]
    public async Task FunctionResultContent_NullResult_EmitsEmptyString()
    {
        var frc = new FunctionResultContent("call-1", null);
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Tool,
            Contents = [frc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var resultEvent = events.OfType<ToolCallResultEvent>().Single();
        Assert.Equal("", resultEvent.Content);
    }

    [Fact]
    public async Task FunctionResultContent_JsonElementResult_EmitsRawText()
    {
        var json = JsonDocument.Parse("{\"status\":\"ok\"}").RootElement.Clone();
        var frc = new FunctionResultContent("call-1", json);
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Tool,
            Contents = [frc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var resultEvent = events.OfType<ToolCallResultEvent>().Single();
        Assert.Contains("status", resultEvent.Content);
        Assert.Contains("ok", resultEvent.Content);
    }

    [Fact]
    public async Task FunctionResultContent_ObjectResult_SerializesToJson()
    {
        var frc = new FunctionResultContent("call-1",
            new Dictionary<string, object?> { ["key"] = "value" });
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Tool,
            Contents = [frc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var resultEvent = events.OfType<ToolCallResultEvent>().Single();
        Assert.Contains("key", resultEvent.Content);
        Assert.Contains("value", resultEvent.Content);
    }

    #endregion

    #region Tool Approval (Interrupts)

    [Fact]
    public async Task ToolApprovalRequestContent_EmitsInterruptRunFinished()
    {
        var toolCall = new FunctionCallContent("call-1", "delete_file",
            new Dictionary<string, object?> { ["path"] = "/tmp/file.txt" });
        var approval = new ToolApprovalRequestContent("req-1", toolCall);

        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [approval]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        // Verify ToolCallStart/Args/End events are emitted before the interrupt
        var toolCallStart = events.OfType<ToolCallStartEvent>().Single();
        Assert.Equal("call-1", toolCallStart.ToolCallId);
        Assert.Equal("delete_file", toolCallStart.ToolCallName);

        var toolCallArgs = events.OfType<ToolCallArgsEvent>().Single();
        Assert.Equal("call-1", toolCallArgs.ToolCallId);
        Assert.Contains("path", toolCallArgs.Delta);

        var toolCallEnd = events.OfType<ToolCallEndEvent>().Single();
        Assert.Equal("call-1", toolCallEnd.ToolCallId);

        // Verify ordering: ToolCallStart < ToolCallArgs < ToolCallEnd < RunFinished
        var startIdx = events.IndexOf(toolCallStart);
        var argsIdx = events.IndexOf(toolCallArgs);
        var endIdx = events.IndexOf(toolCallEnd);
        var finishedIdx = events.FindIndex(e => e is RunFinishedEvent);
        Assert.True(startIdx < argsIdx);
        Assert.True(argsIdx < endIdx);
        Assert.True(endIdx < finishedIdx);

        var finished = events.OfType<RunFinishedEvent>().Single();
        var interruptOutcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        Assert.Single(interruptOutcome.Interrupts);
        var interrupt = interruptOutcome.Interrupts[0];
        Assert.Equal("req-1", interrupt.Id);
        Assert.Equal(InterruptReasons.ToolCall, interrupt.Reason);
        Assert.Equal("call-1", interrupt.ToolCallId);
        Assert.Equal("Approval required for tool call: delete_file", interrupt.Message);

        // Verify ResponseSchema carries the approval schema
        Assert.NotNull(interrupt.ResponseSchema);
        var schema = interrupt.ResponseSchema!.Value;
        Assert.Equal("object", schema.GetProperty("type").GetString());
        Assert.True(schema.GetProperty("properties").TryGetProperty("approved", out _));
    }

    [Fact]
    public async Task ToolApprovalRequestContent_ClosesOpenTextMessage()
    {
        var toolCall = new FunctionCallContent("call-1", "delete_file");
        var approval = new ToolApprovalRequestContent("req-1", toolCall);

        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "I need to delete a file")
            {
                MessageId = "msg-1"
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents = [approval]
            });

        var events = await CollectEvents(updates);

        // Verify text message is closed before the tool call events and interrupt
        var textEndIndex = events.FindIndex(e => e is TextMessageEndEvent);
        var toolStartIndex = events.FindIndex(e => e is ToolCallStartEvent);
        var finishedIndex = events.FindIndex(e => e is RunFinishedEvent);

        Assert.True(textEndIndex < toolStartIndex,
            "TextMessageEnd should come before ToolCallStart");
        Assert.True(toolStartIndex < finishedIndex,
            "ToolCallStart should come before RunFinished interrupt");
    }

    [Fact]
    public async Task ToolApprovalRequestContent_PreventsAutoRunFinished()
    {
        var toolCall = new FunctionCallContent("call-1", "delete_file");
        var approval = new ToolApprovalRequestContent("req-1", toolCall);

        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [approval]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        // Should only have ONE RunFinishedEvent (the interrupt), not a second auto-generated one
        var finishedEvents = events.OfType<RunFinishedEvent>().ToList();
        Assert.Single(finishedEvents);
        Assert.IsType<RunFinishedInterruptOutcome>(finishedEvents[0].Outcome);
    }

    #endregion

    #region Raw Representation Pass-Through

    [Fact]
    public async Task RawRepresentation_BaseEvent_PassedThrough()
    {
        var custom = new CustomEvent
        {
            Name = "my.custom.event",
            Value = JsonDocument.Parse("{\"data\":42}").RootElement.Clone()
        };

        var update = new ChatResponseUpdate { RawRepresentation = custom };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        // RunStarted (auto), custom event, RunFinished (auto)
        Assert.IsType<RunStartedEvent>(events[0]);
        Assert.Same(custom, events[1]);
        Assert.IsType<RunFinishedEvent>(events[2]);
    }

    [Fact]
    public async Task RawRepresentation_RunStartedEvent_EmittedFirst_ThenOtherEvents()
    {
        var rawStarted = new RunStartedEvent { ThreadId = "t", RunId = "r" };
        var rawCustom = new CustomEvent { Name = "x" };

        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate { RawRepresentation = rawStarted },
            new ChatResponseUpdate { RawRepresentation = rawCustom });

        var events = await CollectEvents(updates);

        Assert.Same(rawStarted, events[0]);
        Assert.Same(rawCustom, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_NonRunStartedEvent_EmitsAutoRunStartedFirst()
    {
        var rawCustom = new CustomEvent { Name = "x" };
        var update = new ChatResponseUpdate { RawRepresentation = rawCustom };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.IsType<RunStartedEvent>(events[0]);
        var started = (RunStartedEvent)events[0];
        Assert.Equal(ThreadId, started.ThreadId);
        Assert.Equal(RunId, started.RunId);
    }

    [Fact]
    public async Task RawRepresentation_StepStartedEvent_PassedThrough()
    {
        var stepStarted = new StepStartedEvent { StepName = "step-1" };
        var update = new ChatResponseUpdate { RawRepresentation = stepStarted };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.IsType<RunStartedEvent>(events[0]);
        Assert.Same(stepStarted, events[1]);
        Assert.IsType<RunFinishedEvent>(events[2]);
    }

    [Fact]
    public async Task RawRepresentation_StepFinishedEvent_PassedThrough()
    {
        var stepFinished = new StepFinishedEvent { StepName = "step-1" };
        var update = new ChatResponseUpdate { RawRepresentation = stepFinished };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.Same(stepFinished, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_StateSnapshotEvent_PassedThrough()
    {
        var stateSnapshot = new StateSnapshotEvent
        {
            Snapshot = JsonDocument.Parse("{\"counter\":1}").RootElement.Clone()
        };
        var update = new ChatResponseUpdate { RawRepresentation = stateSnapshot };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.Same(stateSnapshot, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_StateDeltaEvent_PassedThrough()
    {
        var stateDelta = new StateDeltaEvent
        {
            Delta = JsonDocument.Parse("[{\"op\":\"replace\",\"path\":\"/counter\",\"value\":2}]").RootElement.Clone()
        };
        var update = new ChatResponseUpdate { RawRepresentation = stateDelta };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.Same(stateDelta, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_RawEvent_PassedThrough()
    {
        var rawEvent = new RawEvent
        {
            Event = JsonDocument.Parse("{\"data\":42}").RootElement.Clone(),
            Source = "test-source"
        };
        var update = new ChatResponseUpdate { RawRepresentation = rawEvent };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.Same(rawEvent, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_MessagesSnapshotEvent_PassedThrough()
    {
        var messagesSnapshot = new MessagesSnapshotEvent
        {
            Messages =
            [
                new AGUIUserMessage { Id = "msg1", Content = [new AGUITextInputContent { Text = "Hello" }] }
            ]
        };
        var update = new ChatResponseUpdate { RawRepresentation = messagesSnapshot };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.Same(messagesSnapshot, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_ReasoningStartEvent_PassedThrough()
    {
        var reasoningStart = new ReasoningStartEvent();
        var update = new ChatResponseUpdate { RawRepresentation = reasoningStart };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.Same(reasoningStart, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_ActivitySnapshotEvent_PassedThrough()
    {
        var activitySnapshot = new ActivitySnapshotEvent
        {
            MessageId = "act-1",
            ActivityType = "search",
            Content = JsonDocument.Parse("{\"title\":\"Searching\"}").RootElement.Clone()
        };
        var update = new ChatResponseUpdate { RawRepresentation = activitySnapshot };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.Same(activitySnapshot, events[1]);
    }

    [Fact]
    public async Task RawRepresentation_RunErrorEvent_PassedThrough()
    {
        var runError = new RunErrorEvent { Message = "Something went wrong", Code = "INTERNAL_ERROR" };
        var update = new ChatResponseUpdate { RawRepresentation = runError };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        Assert.IsType<RunStartedEvent>(events[0]);
        var passedError = Assert.IsType<RunErrorEvent>(events[1]);
        Assert.Same(runError, passedError);
        Assert.Equal("Something went wrong", passedError.Message);
        Assert.Equal("INTERNAL_ERROR", passedError.Code);
        Assert.IsType<RunFinishedEvent>(events[2]);
    }

    [Fact]
    public async Task RawRepresentation_MultipleEventTypes_AllPassedThrough()
    {
        var stepStarted = new StepStartedEvent { StepName = "step-1" };
        var stateSnapshot = new StateSnapshotEvent
        {
            Snapshot = JsonDocument.Parse("{\"count\":0}").RootElement.Clone()
        };
        var reasoningStart = new ReasoningStartEvent();
        var reasoningEnd = new ReasoningEndEvent();
        var stepFinished = new StepFinishedEvent { StepName = "step-1" };

        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate { RawRepresentation = stepStarted },
            new ChatResponseUpdate { RawRepresentation = stateSnapshot },
            new ChatResponseUpdate { RawRepresentation = reasoningStart },
            new ChatResponseUpdate { RawRepresentation = reasoningEnd },
            new ChatResponseUpdate { RawRepresentation = stepFinished });

        var events = await CollectEvents(updates);

        // RunStarted(auto), stepStarted, stateSnapshot, reasoningStart, reasoningEnd, stepFinished, RunFinished(auto)
        Assert.Equal(7, events.Count);
        Assert.IsType<RunStartedEvent>(events[0]);
        Assert.Same(stepStarted, events[1]);
        Assert.Same(stateSnapshot, events[2]);
        Assert.Same(reasoningStart, events[3]);
        Assert.Same(reasoningEnd, events[4]);
        Assert.Same(stepFinished, events[5]);
        Assert.IsType<RunFinishedEvent>(events[6]);
    }

    #endregion

    #region Unmapped Update Handler

    [Fact]
    public async Task UnmappedUpdateHandler_InvokedForUnknownContentTypes()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [customContent]
        };

        var handlerCalled = false;
        BaseEvent[]? handlerResult = null;

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            unmappedUpdateHandler: (chatUpdate, content) =>
            {
                handlerCalled = true;
                handlerResult =
                [
                    new CustomEvent
                    {
                        Name = "custom.data",
                        Value = JsonDocument.Parse("\"handled\"").RootElement.Clone()
                    }
                ];
                return handlerResult;
            });

        Assert.True(handlerCalled);
        Assert.Contains(events, e => e is CustomEvent ce && ce.Name == "custom.data");
    }

    [Fact]
    public async Task UnmappedUpdateHandler_NullReturn_SkipsContent()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [customContent]
        };

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            unmappedUpdateHandler: (_, _) => null);

        // Should only have RunStarted and RunFinished (no custom events)
        Assert.Equal(2, events.Count);
        Assert.IsType<RunStartedEvent>(events[0]);
        Assert.IsType<RunFinishedEvent>(events[1]);
    }

    [Fact]
    public async Task UnmappedUpdateHandler_NotCalledForTextContent()
    {
        var update = new ChatResponseUpdate(ChatRole.Assistant, "Hello")
        {
            MessageId = "msg-1"
        };

        var handlerCalled = false;

        await CollectEvents(
            ToAsyncEnumerable(update),
            unmappedUpdateHandler: (_, _) =>
            {
                handlerCalled = true;
                return null;
            });

        Assert.False(handlerCalled);
    }

    [Fact]
    public async Task UnmappedUpdateHandler_RunFinishedEvent_FromHandler_PreventsAutoEmit()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [customContent]
        };

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            unmappedUpdateHandler: (_, _) => new BaseEvent[]
            {
                new RunFinishedEvent
                {
                    ThreadId = ThreadId,
                    RunId = RunId,
                    Outcome = new RunFinishedSuccessOutcome()
                }
            });

        var finishedEvents = events.OfType<RunFinishedEvent>().ToList();
        Assert.Single(finishedEvents);
        Assert.IsType<RunFinishedSuccessOutcome>(finishedEvents[0].Outcome);
    }

    #endregion

    #region Interrupt Mapper

    [Fact]
    public async Task InterruptMapper_ReturnsInterrupt_EmitsRunFinishedWithInterrupt()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [customContent]
        };

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, content) =>
            {
                if (content is DataContent)
                {
                    return new AGUIInterrupt
                    {
                        Id = "int-1",
                        Reason = "user_input",
                        Message = "Enter email"
                    };
                }

                return null;
            });

        var finished = events.OfType<RunFinishedEvent>().Single();
        var interruptOutcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        Assert.Single(interruptOutcome.Interrupts);
        Assert.Equal("int-1", interruptOutcome.Interrupts[0].Id);
        Assert.Equal("user_input", interruptOutcome.Interrupts[0].Reason);
        Assert.Equal("Enter email", interruptOutcome.Interrupts[0].Message);
    }

    [Fact]
    public async Task InterruptMapper_ReturnsNull_FallsThroughToUnmappedHandler()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [customContent]
        };

        var unmappedHandlerCalled = false;

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, _) => null,
            unmappedUpdateHandler: (_, _) =>
            {
                unmappedHandlerCalled = true;
                return [new CustomEvent { Name = "fallback" }];
            });

        Assert.True(unmappedHandlerCalled);
        Assert.Contains(events, e => e is CustomEvent ce && ce.Name == "fallback");
    }

    [Fact]
    public async Task InterruptMapper_ClosesOpenTextMessage_BeforeInterrupt()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");

        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Processing...")
            {
                MessageId = "msg-1"
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents = [customContent]
            });

        var events = await CollectEvents(
            updates,
            interruptMapper: (_, content) =>
            {
                if (content is DataContent)
                {
                    return new AGUIInterrupt { Id = "int-1", Reason = "policy_hold" };
                }

                return null;
            });

        var textEndIndex = events.FindIndex(e => e is TextMessageEndEvent);
        var finishedIndex = events.FindIndex(e => e is RunFinishedEvent);

        Assert.True(textEndIndex < finishedIndex,
            "TextMessageEnd should come before RunFinished interrupt");

        var textEnd = Assert.IsType<TextMessageEndEvent>(events[textEndIndex]);
        Assert.Equal("msg-1", textEnd.MessageId);
    }

    [Fact]
    public async Task InterruptMapper_PreventsAutoRunFinished()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [customContent]
        };

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, _) => new AGUIInterrupt
            {
                Id = "int-1",
                Reason = "upload_required"
            });

        var finishedEvents = events.OfType<RunFinishedEvent>().ToList();
        Assert.Single(finishedEvents);
        Assert.IsType<RunFinishedInterruptOutcome>(finishedEvents[0].Outcome);
    }

    [Fact]
    public async Task InterruptMapper_NotCalledForTextContent()
    {
        var update = new ChatResponseUpdate(ChatRole.Assistant, "Hello")
        {
            MessageId = "msg-1"
        };

        var mapperCalled = false;

        await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, _) =>
            {
                mapperCalled = true;
                return null;
            });

        Assert.False(mapperCalled);
    }

    [Fact]
    public async Task InterruptMapper_NotCalledForFunctionCallContent()
    {
        var fcc = new FunctionCallContent("call-1", "my_tool");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [fcc]
        };

        var mapperCalled = false;

        await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, _) =>
            {
                mapperCalled = true;
                return null;
            });

        Assert.False(mapperCalled);
    }

    [Fact]
    public async Task InterruptMapper_NotCalledForToolApprovalRequestContent()
    {
        var toolCall = new FunctionCallContent("call-1", "delete_file");
        var approval = new ToolApprovalRequestContent("req-1", toolCall);
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [approval]
        };

        var mapperCalled = false;

        await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, _) =>
            {
                mapperCalled = true;
                return null;
            });

        Assert.False(mapperCalled);
    }

    [Fact]
    public async Task InterruptMapper_CustomReason_PreservedInRunFinished()
    {
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [customContent]
        };

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, _) => new AGUIInterrupt
            {
                Id = "int-db-1",
                Reason = "database_modification",
                Message = "DELETE on users affecting 42 rows",
                Metadata = JsonDocument.Parse("{\"action\":\"DELETE\",\"table\":\"users\",\"affectedRows\":42}").RootElement.Clone()
            });

        var finished = events.OfType<RunFinishedEvent>().Single();
        var interruptOutcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        Assert.Equal("int-db-1", interruptOutcome.Interrupts[0].Id);
        Assert.Equal("database_modification", interruptOutcome.Interrupts[0].Reason);
        Assert.Equal("DELETE", interruptOutcome.Interrupts[0].Metadata!.Value.GetProperty("action").GetString());
        Assert.Equal(42, interruptOutcome.Interrupts[0].Metadata!.Value.GetProperty("affectedRows").GetInt32());
    }

    [Fact]
    public async Task MultipleInterrupts_AreAccumulatedIntoSingleRunFinished()
    {
        // A built-in (tool-approval) interrupt and a custom-mapped interrupt in the same response
        // must finish the run with exactly one RUN_FINISHED carrying both interrupts — not two
        // RUN_FINISHED events (which produce an invalid stream the client decoder rejects).
        var toolCall = new FunctionCallContent("call-1", "delete_file");
        var approval = new ToolApprovalRequestContent("req-approval", toolCall);
        var customContent = new DataContent("data:text/plain;base64,SGVsbG8=", "text/plain");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [approval, customContent]
        };

        var events = await CollectEvents(
            ToAsyncEnumerable(update),
            interruptMapper: (_, content) => content is DataContent
                ? new AGUIInterrupt { Id = "int-custom", Reason = "custom_reason" }
                : null);

        var finished = events.OfType<RunFinishedEvent>().Single();
        var interruptOutcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        Assert.Equal(2, interruptOutcome.Interrupts.Count);
        Assert.Contains(interruptOutcome.Interrupts, i => i.Id == "req-approval");
        Assert.Contains(interruptOutcome.Interrupts, i => i.Id == "int-custom");
    }

    #endregion

    #region RawEvent Attachment

    [Fact]
    public async Task NonRawRepresentation_Updates_HaveRawEventAttached()
    {
        var update = new ChatResponseUpdate(ChatRole.Assistant, "Hello")
        {
            MessageId = "msg-1"
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var start = events.OfType<TextMessageStartEvent>().Single();
        Assert.NotNull(start.RawEvent);

        var content = events.OfType<TextMessageContentEvent>().Single();
        Assert.NotNull(content.RawEvent);
    }

    #endregion

    #region Unicode and Special Characters (GAP-7)

    [Fact]
    public async Task TextContent_WithEmoji_PreservedInDelta()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Hello 🚀 World 😊")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        var content = events.OfType<TextMessageContentEvent>().Single();
        Assert.Equal("Hello 🚀 World 😊", content.Delta);
    }

    [Fact]
    public async Task TextContent_WithUnicodeAndEscapeSequences_PreservedInDelta()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Special: ñ € « » \n\t\"quoted\"")
            {
                MessageId = "msg-1"
            });

        var events = await CollectEvents(updates);

        var content = events.OfType<TextMessageContentEvent>().Single();
        Assert.Contains("ñ", content.Delta);
        Assert.Contains("€", content.Delta);
        Assert.Contains("\n", content.Delta);
        Assert.Contains("\t", content.Delta);
        Assert.Contains("\"quoted\"", content.Delta);
    }

    [Fact]
    public async Task ToolCallArgs_WithUnicodeValues_SerializedCorrectly()
    {
        var args = new Dictionary<string, object?>
        {
            ["city"] = "München",
            ["emoji"] = "🌍"
        };
        var fcc = new FunctionCallContent("call-1", "search", args);
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [fcc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var toolArgs = events.OfType<ToolCallArgsEvent>().Single();
        Assert.Contains("München", toolArgs.Delta);
    }

    [Fact]
    public async Task FunctionResultContent_WithUnicodeResult_PreservedInResult()
    {
        var frc = new FunctionResultContent("call-1", "Résultat: 42°C — succès ✓");
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Tool,
            Contents = [frc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var result = events.OfType<ToolCallResultEvent>().Single();
        Assert.Equal("Résultat: 42°C — succès ✓", result.Content);
    }

    #endregion

    #region Mixed Content Scenarios

    [Fact]
    public async Task TextThenToolCall_ClosesTextBeforeToolEvents()
    {
        var updates = ToAsyncEnumerable(
            new ChatResponseUpdate(ChatRole.Assistant, "Let me check")
            {
                MessageId = "msg-1"
            },
            new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents = [new FunctionCallContent("call-1", "lookup")]
            });

        var events = await CollectEvents(updates);

        var eventTypes = events.Select(e => e.GetType().Name).ToList();

        Assert.Equal("RunStartedEvent", eventTypes[0]);
        Assert.Equal("TextMessageStartEvent", eventTypes[1]);
        Assert.Equal("TextMessageContentEvent", eventTypes[2]);
        Assert.Equal("TextMessageEndEvent", eventTypes[3]);
        Assert.Equal("ToolCallStartEvent", eventTypes[4]);
        Assert.Equal("ToolCallArgsEvent", eventTypes[5]);
        Assert.Equal("ToolCallEndEvent", eventTypes[6]);
        Assert.Equal("RunFinishedEvent", eventTypes[7]);
    }

    [Fact]
    public async Task ToolCallArgsEvent_SerializesArgumentsAsJson()
    {
        var args = new Dictionary<string, object?>
        {
            ["name"] = "test",
            ["count"] = 42
        };
        var fcc = new FunctionCallContent("call-1", "my_tool", args);
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [fcc]
        };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var toolArgs = events.OfType<ToolCallArgsEvent>().Single();
        var parsed = JsonDocument.Parse(toolArgs.Delta);
        Assert.Equal("test", parsed.RootElement.GetProperty("name").GetString());
    }

    #endregion

    #region Cancellation

    [Fact]
    public async Task CancellationToken_StopsEventStream()
    {
        var cts = new CancellationTokenSource();
        var updates = GenerateInfiniteUpdates(cts.Token);
        var collected = new List<BaseEvent>();

        await foreach (var evt in updates.AsAGUIEventStreamAsync(
            BuildContext(), cancellationToken: cts.Token))
        {
            collected.Add(evt);
            if (collected.Count >= 3)
            {
                cts.Cancel();
                break;
            }
        }

        Assert.True(collected.Count >= 3);
        Assert.IsType<RunStartedEvent>(collected[0]);
    }

    #endregion

    #region Tool Call Result

    // https://github.com/microsoft/agent-framework/issues/3962
    // Issue #3962 — RESOLVED AS BY-DESIGN. A tool result is identified by its toolCallId in
    // BOTH conversion directions: the response side sets TOOL_CALL_RESULT.messageId = toolCallId
    // and the outbound AsAGUIMessages keys each AGUIToolMessage.Id on the call id. This keeps the
    // identity deterministic (the wire messageId is otherwise dropped/echoed by clients).
    [Fact]
    public async Task ToolCallResult_MessageId_EqualsToolCallId_ByDesign()
    {
        var frc = new FunctionResultContent("call-1", "result-data");
        var update = new ChatResponseUpdate { Role = ChatRole.Tool, Contents = [frc] };

        var events = await CollectEvents(ToAsyncEnumerable(update));

        var resultEvent = events.OfType<ToolCallResultEvent>().Single();
        Assert.Equal("call-1", resultEvent.ToolCallId);
        Assert.Equal(resultEvent.ToolCallId, resultEvent.MessageId);
    }

    #endregion

    #region Helpers

    private static async Task<List<BaseEvent>> CollectEvents(
        IAsyncEnumerable<ChatResponseUpdate> updates,
        Func<ChatResponseUpdate, AIContent, AGUIInterrupt?>? interruptMapper = null,
        Func<ChatResponseUpdate, AIContent, IEnumerable<BaseEvent>?>? unmappedUpdateHandler = null)
    {
        var options = new AGUIStreamOptions();
        if (interruptMapper is not null)
        {
            options.MapInterrupt(content => interruptMapper(null!, content));
        }
        if (unmappedUpdateHandler is not null)
        {
            options.MapContent(content => unmappedUpdateHandler(null!, content));
        }

        var events = new List<BaseEvent>();
        await foreach (var evt in updates.AsAGUIEventStreamAsync(BuildContext(options)).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        return events;
    }

    private static ChatRequestContext BuildContext(AGUIStreamOptions? streamOptions = null) =>
        new RunAgentInput { ThreadId = ThreadId, RunId = RunId }
            .ToChatRequestContext(SerializerOptions, streamOptions);

    private static async IAsyncEnumerable<ChatResponseUpdate> ToAsyncEnumerable(
        params ChatResponseUpdate[] items)
    {
        foreach (var item in items)
        {
            yield return item;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> GenerateInfiniteUpdates(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var i = 0;
        while (!ct.IsCancellationRequested)
        {
            yield return new ChatResponseUpdate(ChatRole.Assistant, $"chunk-{i++}")
            {
                MessageId = "msg-infinite"
            };
            await Task.Yield();
        }
    }

    #endregion
}
