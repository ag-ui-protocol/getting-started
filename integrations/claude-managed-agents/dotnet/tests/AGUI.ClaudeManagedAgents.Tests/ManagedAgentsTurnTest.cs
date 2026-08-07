using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsTurnTest
{
    private const string IdleEndTurn =
        """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"end_turn"}}""";

    private sealed class TurnRun
    {
        internal List<BaseEvent> Emitted { get; } = [];

        internal ManagedAgentsTurnOutcome Outcome { get; set; } = ManagedAgentsTurnOutcome.Errored;

        internal FakeManagedAgentsClient Fake { get; set; } = null!;
    }

    private static async Task<TurnRun> CollectAsync(
        IReadOnlyList<string> streamEvents,
        FakeManagedAgentsClient? fake = null,
        IReadOnlyDictionary<string, string>? clientTools = null,
        IReadOnlyDictionary<string, ManagedAgentsBackendTool>? backendTools = null,
        string? toolConfirmation = null)
    {
        fake ??= new FakeManagedAgentsClient(streamEvents);
        var turn = new ManagedAgentsTurn(
            fake,
            "sesn_1",
            [ManagedAgentsSessionEvents.UserMessage("hi")],
            clientTools ?? new Dictionary<string, string>(),
            backendTools ?? new Dictionary<string, ManagedAgentsBackendTool>(),
            toolConfirmation,
            streamDeltas: true);

        var run = new TurnRun { Fake = fake };
        await foreach (var evt in turn.RunAsync())
        {
            run.Emitted.Add(evt);
        }

        run.Outcome = turn.Outcome;
        return run;
    }

    private static IEnumerable<string> Types(IEnumerable<BaseEvent> events) => events.Select(e => e.Type);

    private static void AssertJson(string expected, JsonElement actual)
    {
        var expectedElement = FakeManagedAgentsClient.Json(expected);
        Assert.True(
            JsonElement.DeepEquals(expectedElement, actual),
            $"Expected {expectedElement.GetRawText()}\nActual   {actual.GetRawText()}");
    }

    [Fact]
    public void AParkedOutcomeWithNoToolCallsIsUnrepresentable()
    {
        // A park with nothing to answer would leave the session waiting on a call the next run
        // cannot identify, so the outcome type refuses to model it at all.
        Assert.Throws<ArgumentException>(() => ManagedAgentsTurnOutcome.Parked([]));
        Assert.Empty(ManagedAgentsTurnOutcome.Finished.ClientToolUseIds);
        Assert.Empty(ManagedAgentsTurnOutcome.Errored.ClientToolUseIds);
        Assert.False(ManagedAgentsTurnOutcome.Errored.SessionEnded);
        Assert.True(ManagedAgentsTurnOutcome.ErroredSessionEnded.SessionEnded);
    }

    [Fact]
    public async Task StreamsTextPreviewTopsItUpFromBufferedMessageAndFinishes()
    {
        var run = await CollectAsync([
            """{"type":"session.status_running","id":"run_1"}""",
            """{"type":"event_start","event":{"type":"agent.message","id":"msg_1"}}""",
            """{"type":"event_delta","event_id":"msg_1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"Hel"}}}""",
            """{"type":"event_delta","event_id":"msg_1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"lo"}}}""",
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Hello there"}]}""",
            IdleEndTurn,
        ]);

        Assert.Equal(ManagedAgentsTurnStatus.Finished, run.Outcome.Status);
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"hi"}]}""", run.Fake.Sent[0].Single());

        Assert.Collection(run.Emitted,
            e => Assert.Equal(("msg_1", AGUIRoles.Assistant), (Assert.IsType<TextMessageStartEvent>(e).MessageId, Assert.IsType<TextMessageStartEvent>(e).Role)),
            e => Assert.Equal(("msg_1", "Hel"), (Assert.IsType<TextMessageContentEvent>(e).MessageId, Assert.IsType<TextMessageContentEvent>(e).Delta)),
            e => Assert.Equal(("msg_1", "lo"), (Assert.IsType<TextMessageContentEvent>(e).MessageId, Assert.IsType<TextMessageContentEvent>(e).Delta)),
            e => Assert.Equal(("msg_1", " there"), (Assert.IsType<TextMessageContentEvent>(e).MessageId, Assert.IsType<TextMessageContentEvent>(e).Delta)),
            e => Assert.Equal("msg_1", Assert.IsType<TextMessageEndEvent>(e).MessageId));
    }

    [Fact]
    public async Task EmitsAWholeMessageWhenThereWasNoPreview()
    {
        var run = await CollectAsync([
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"All at once"}]}""",
            IdleEndTurn,
        ]);

        Assert.Collection(run.Emitted,
            e => Assert.Equal("msg_1", Assert.IsType<TextMessageStartEvent>(e).MessageId),
            e => Assert.Equal("All at once", Assert.IsType<TextMessageContentEvent>(e).Delta),
            e => Assert.Equal("msg_1", Assert.IsType<TextMessageEndEvent>(e).MessageId));
    }

    [Fact]
    public async Task ReEmitsACorrectedMessageWhenThePreviewDiverges()
    {
        var run = await CollectAsync([
            """{"type":"event_start","event":{"type":"agent.message","id":"msg_1"}}""",
            """{"type":"event_delta","event_id":"msg_1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"Draft"}}}""",
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Final"}]}""",
            IdleEndTurn,
        ]);

        Assert.Collection(run.Emitted,
            e => Assert.Equal("msg_1", Assert.IsType<TextMessageStartEvent>(e).MessageId),
            e => Assert.Equal("Draft", Assert.IsType<TextMessageContentEvent>(e).Delta),
            e => Assert.Equal("msg_1", Assert.IsType<TextMessageEndEvent>(e).MessageId),
            e => Assert.Equal("corrected_msg_1", Assert.IsType<TextMessageStartEvent>(e).MessageId),
            e => Assert.Equal(("corrected_msg_1", "Final"), (Assert.IsType<TextMessageContentEvent>(e).MessageId, Assert.IsType<TextMessageContentEvent>(e).Delta)),
            e => Assert.Equal("corrected_msg_1", Assert.IsType<TextMessageEndEvent>(e).MessageId));
    }

    [Fact]
    public async Task MapsAThinkingStretchToReasoningStartAndEnd()
    {
        var run = await CollectAsync([
            """{"type":"event_start","event":{"type":"agent.thinking","id":"think_1"}}""",
            """{"type":"agent.thinking","id":"think_1"}""",
            IdleEndTurn,
        ]);

        Assert.Equal(
            [
                AGUIEventTypes.ReasoningStart,
                AGUIEventTypes.ReasoningMessageStart,
                AGUIEventTypes.ReasoningMessageEnd,
                AGUIEventTypes.ReasoningEnd,
            ],
            Types(run.Emitted));
    }

    [Fact]
    public async Task StreamsBuiltInToolCallsAndTheirResults()
    {
        var run = await CollectAsync([
            """{"type":"agent.tool_use","id":"tu_1","name":"bash","input":{"command":"ls"}}""",
            """{"type":"agent.tool_result","id":"tr_1","tool_use_id":"tu_1","content":[{"type":"text","text":"file.txt"}]}""",
            IdleEndTurn,
        ]);

        Assert.Collection(run.Emitted,
            e =>
            {
                var start = Assert.IsType<ToolCallStartEvent>(e);
                Assert.Equal(("tu_1", "bash"), (start.ToolCallId, start.ToolCallName));
            },
            e =>
            {
                var args = Assert.IsType<ToolCallArgsEvent>(e);
                Assert.Equal(("tu_1", """{"command":"ls"}"""), (args.ToolCallId, args.Delta));
            },
            e => Assert.Equal("tu_1", Assert.IsType<ToolCallEndEvent>(e).ToolCallId),
            e =>
            {
                var result = Assert.IsType<ToolCallResultEvent>(e);
                Assert.Equal(("result_tu_1", "tu_1", "file.txt", AGUIRoles.Tool), (result.MessageId, result.ToolCallId, result.Content, result.Role));
            });
    }

    [Fact]
    public async Task MapsMcpToolCallsWithAServerQualifiedName()
    {
        var run = await CollectAsync([
            """{"type":"agent.mcp_tool_use","id":"mcp_1","name":"search","mcp_server_name":"docs","input":{"q":"x"}}""",
            """{"type":"agent.mcp_tool_result","id":"mr_1","mcp_tool_use_id":"mcp_1","content":[{"type":"text","text":"found"}]}""",
            IdleEndTurn,
        ]);

        var start = Assert.IsType<ToolCallStartEvent>(run.Emitted[0]);
        Assert.Equal(("mcp_1", "docs: search"), (start.ToolCallId, start.ToolCallName));
        var result = Assert.IsType<ToolCallResultEvent>(run.Emitted[3]);
        Assert.Equal(("mcp_1", "found"), (result.ToolCallId, result.Content));
    }

    [Fact]
    public async Task RunsABackendToolAndPostsItsResultBackIntoTheSession()
    {
        var backend = new ManagedAgentsBackendTool
        {
            Name = "get_time",
            Handler = _ => Task.FromResult("noon"),
        };
        var run = await CollectAsync(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""",
                """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["ctu_1"]}}""",
                IdleEndTurn,
            ],
            backendTools: new Dictionary<string, ManagedAgentsBackendTool> { ["get_time"] = backend });

        var result = run.Emitted.OfType<ToolCallResultEvent>().Single();
        Assert.Equal(("result_ctu_1", "ctu_1", "noon", AGUIRoles.Tool), (result.MessageId, result.ToolCallId, result.Content, result.Role));
        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"noon"}],"is_error":false}""",
            run.Fake.Sent[1].Single());
    }

    [Fact]
    public async Task NeverReportsAToolResultTheSessionDidNotReceiveAndInterrupts()
    {
        // Regression: the result is delivered before the UI is told about it. A TOOL_CALL_RESULT
        // the agent never saw would report a success that did not happen, and the session stays
        // parked on the call — so it is interrupted.
        var backend = new ManagedAgentsBackendTool
        {
            Name = "get_time",
            Handler = _ => Task.FromResult("noon"),
        };
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""",
            IdleEndTurn,
        ])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.custom_tool_result")
                ? new InvalidOperationException("send failed")
                : null,
        };

        var run = await CollectAsync(
            [],
            fake,
            backendTools: new Dictionary<string, ManagedAgentsBackendTool> { ["get_time"] = backend });

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        Assert.Empty(run.Emitted.OfType<ToolCallResultEvent>());
        var error = Assert.IsType<RunErrorEvent>(run.Emitted[^1]);
        Assert.Equal("tool_result_delivery_failed", error.Code);
        Assert.Equal(
            "The result of tool call ctu_1 could not be delivered to the session.",
            error.Message);
        Assert.Contains("user.interrupt", run.Fake.SentTypes);
    }

    [Fact]
    public async Task ReportsItsOwnCauseWhenAToolConfirmationCannotBeDelivered()
    {
        // Regression: the HTTP client's TaskCanceledException escaped the confirmation send and
        // the interrupt, so the run degraded to run_failed instead of naming the real cause.
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.tool_use","id":"tu_1","name":"bash","input":{},"evaluated_permission":"ask"}""",
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["tu_1"]}}""",
        ])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.tool_confirmation")
                ? new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout")
                : null,
        };

        var run = await CollectAsync([], fake, toolConfirmation: "allow");

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        Assert.Equal("tool_confirmation_delivery_failed", Assert.IsType<RunErrorEvent>(run.Emitted[^1]).Code);
        // The session is parked on the confirmation, so it is interrupted.
        Assert.Contains("user.interrupt", run.Fake.SentTypes);
    }

    [Fact]
    public async Task BoundsTheBestEffortInterrupt()
    {
        // Regression: the interrupt was sent with CancellationToken.None, so a stalled connection
        // held the thread's run gate open for as long as the socket did. It must not use the run's
        // (already failing) token either — hence a bounded token of its own.
        var run = await CollectAsync([
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["mystery_1"]}}""",
        ]);

        Assert.Equal("unsupported_action", Assert.IsType<RunErrorEvent>(run.Emitted[^1]).Code);
        var interruptIndex = run.Fake.SendAttempts
            .Select(static (batch, index) => (batch, index))
            .Single(static entry => entry.batch.Any(static e => e.GetProperty("type").GetString() == "user.interrupt"))
            .index;
        var token = run.Fake.SendTokens[interruptIndex];
        Assert.True(token.CanBeCanceled, "the interrupt send must carry a bounded token");
        Assert.False(token.IsCancellationRequested);
    }

    [Fact]
    public async Task AnInterruptThatTimesOutDoesNotReplaceTheRealCause()
    {
        // The interrupt is best-effort; its own timeout must not hijack the unsupported-action
        // error the turn is in the middle of reporting.
        var fake = new FakeManagedAgentsClient([
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["mystery_1"]}}""",
        ])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.interrupt")
                ? new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout")
                : null,
        };

        var run = await CollectAsync([], fake);

        var error = Assert.IsType<RunErrorEvent>(run.Emitted[^1]);
        Assert.Equal("unsupported_action", error.Code);
    }

    [Fact]
    public async Task ReportsADeliveryFailureForAToolNothingCanExecute()
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.custom_tool_use","id":"ctu_1","name":"mystery","input":{}}""",
            IdleEndTurn,
        ])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.custom_tool_result")
                ? new InvalidOperationException("send failed")
                : null,
        };

        var run = await CollectAsync([], fake);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        Assert.Empty(run.Emitted.OfType<ToolCallResultEvent>());
        Assert.Equal("tool_result_delivery_failed", Assert.IsType<RunErrorEvent>(run.Emitted[^1]).Code);
        Assert.Contains("user.interrupt", run.Fake.SentTypes);
    }

    [Fact]
    public async Task EmitsTheToolResultOnlyAfterTheSessionAcceptedIt()
    {
        var backend = new ManagedAgentsBackendTool
        {
            Name = "get_time",
            Handler = _ => Task.FromResult("noon"),
        };
        var order = new List<string>();
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""",
            IdleEndTurn,
        ])
        {
            SendGuard = batch =>
            {
                if (batch.Any(e => e.GetProperty("type").GetString() == "user.custom_tool_result"))
                {
                    order.Add("sent");
                }

                return null;
            },
        };

        var turn = new ManagedAgentsTurn(
            fake,
            "sesn_1",
            [ManagedAgentsSessionEvents.UserMessage("hi")],
            new Dictionary<string, string>(),
            new Dictionary<string, ManagedAgentsBackendTool> { ["get_time"] = backend },
            null,
            streamDeltas: true);

        await foreach (var evt in turn.RunAsync())
        {
            if (evt is ToolCallResultEvent)
            {
                order.Add("emitted");
            }
        }

        Assert.Equal(["sent", "emitted"], order);
    }

    [Fact]
    public async Task PostsAnErrorResultForAToolNothingCanExecute()
    {
        var run = await CollectAsync([
            """{"type":"agent.custom_tool_use","id":"ctu_1","name":"mystery","input":{}}""",
            IdleEndTurn,
        ]);

        var posted = run.Fake.Sent[1].Single();
        Assert.Equal("user.custom_tool_result", posted.GetProperty("type").GetString());
        Assert.Equal("ctu_1", posted.GetProperty("custom_tool_use_id").GetString());
        Assert.True(posted.GetProperty("is_error").GetBoolean());
    }

    private const string IdleUnknownAction =
        """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["mystery_1"]}}""";

    [Fact]
    public async Task RecordsWhetherTheInterruptItSentActuallyLanded()
    {
        // A landed interrupt cancels whatever the session was waiting on, so the caller has to
        // know: any park from this turn is no longer answerable.
        var landed = await CollectAsync([IdleUnknownAction]);
        Assert.True(landed.Outcome.SessionInterrupted);

        var rejecting = new FakeManagedAgentsClient([IdleUnknownAction])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.interrupt")
                ? new InvalidOperationException("interrupt rejected")
                : null,
        };
        var failed = await CollectAsync([], rejecting);
        Assert.Equal(ManagedAgentsTurnStatus.Errored, failed.Outcome.Status);
        Assert.False(failed.Outcome.SessionInterrupted);
    }

    [Fact]
    public async Task ReportsAnUnhandledStopReasonInsteadOfWaitingItOut()
    {
        // Ignoring an unknown stop reason left the turn waiting on a session that will never
        // resume until the timeout fired.
        var run = await CollectAsync([
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"awaiting_martian_input"}}""",
        ]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        var error = Assert.IsType<RunErrorEvent>(run.Emitted[^1]);
        Assert.Equal("unknown_stop_reason", error.Code);
        Assert.Equal(
            "The session went idle for a reason this integration does not handle: awaiting_martian_input.",
            error.Message);
        Assert.Contains("user.interrupt", run.Fake.SentTypes);
    }

    [Fact]
    public async Task EmitsToolArgumentsAsCompactUnescapedJson()
    {
        // All three ports must agree byte for byte: compact, no \uXXXX escaping of non-ASCII and
        // no HTML escaping of < > & (which JsonSerializer applies by default). The input arrives
        // pretty-printed here so the normalization is visible too.
        var run = await CollectAsync([
            """
            {"type":"agent.tool_use","id":"tu_1","name":"search","input":{
                "q": "café <b>&</b> 日本",
                "n": 1
            }}
            """,
            IdleEndTurn,
        ]);

        var args = run.Emitted.OfType<ToolCallArgsEvent>().Single();
        Assert.Equal("""{"q":"café <b>&</b> 日本","n":1}""", args.Delta);
    }

    [Fact]
    public async Task ParksTheTurnWhenTheFrontendMustExecuteATool()
    {
        var run = await CollectAsync(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"confirm_purchase","input":{"amount":5}}""",
                """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["ctu_1"]}}""",
            ],
            clientTools: new Dictionary<string, string> { ["confirm_purchase"] = "confirm_purchase" });

        Assert.Equal(ManagedAgentsTurnStatus.Parked, run.Outcome.Status);
        Assert.Equal(["ctu_1"], run.Outcome.ClientToolUseIds);
        Assert.Single(run.Fake.Sent); // only the user message; no result posted
        Assert.Equal(
            [AGUIEventTypes.ToolCallStart, AGUIEventTypes.ToolCallArgs, AGUIEventTypes.ToolCallEnd],
            Types(run.Emitted));
    }

    [Fact]
    public async Task ReportsTheFrontendsOriginalNameForANormalizedTool()
    {
        var run = await CollectAsync(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"search_web","input":{}}""",
                """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["ctu_1"]}}""",
            ],
            clientTools: new Dictionary<string, string> { ["search_web"] = "search web" });

        Assert.Equal(ManagedAgentsTurnStatus.Parked, run.Outcome.Status);
        Assert.Equal(["ctu_1"], run.Outcome.ClientToolUseIds);
        var start = Assert.IsType<ToolCallStartEvent>(run.Emitted[0]);
        Assert.Equal(("ctu_1", "search web"), (start.ToolCallId, start.ToolCallName));
    }

    [Fact]
    public async Task AnswersAConfirmationGatedToolWhenAPolicyIsConfigured()
    {
        var run = await CollectAsync(
            [
                """{"type":"agent.tool_use","id":"tu_1","name":"bash","input":{},"evaluated_permission":"ask"}""",
                """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["tu_1"]}}""",
                """{"type":"agent.tool_result","id":"tr_1","tool_use_id":"tu_1","content":[]}""",
                IdleEndTurn,
            ],
            toolConfirmation: ToolConfirmationPolicy.Allow);

        Assert.Equal(ManagedAgentsTurnStatus.Finished, run.Outcome.Status);
        AssertJson(
            """{"type":"user.tool_confirmation","tool_use_id":"tu_1","result":"allow"}""",
            run.Fake.Sent[1].Single());
    }

    [Fact]
    public async Task FailsTheRunOnAConfirmationGatedToolWithNoPolicy()
    {
        var run = await CollectAsync([
            """{"type":"agent.tool_use","id":"tu_1","name":"bash","input":{},"evaluated_permission":"ask"}""",
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["tu_1"]}}""",
        ]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        var error = Assert.IsType<RunErrorEvent>(run.Emitted[^1]);
        Assert.Equal("tool_confirmation_required", error.Code);
    }

    [Fact]
    public async Task SurfacesATerminalSessionErrorWithItsTypeAsTheCode()
    {
        var run = await CollectAsync([
            """{"type":"session.error","id":"err_1","error":{"type":"billing_error","message":"Out of credits","retry_status":{"type":"terminal"}}}""",
        ]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        var error = Assert.IsType<RunErrorEvent>(Assert.Single(run.Emitted));
        Assert.Equal(("Out of credits", "billing_error"), (error.Message, error.Code));
    }

    [Fact]
    public async Task UsesADefaultMessageForASessionErrorWithoutOne()
    {
        var run = await CollectAsync([
            """{"type":"session.error","id":"err_1","error":{"type":"unknown_error","message":"","retry_status":{"type":"terminal"}}}""",
        ]);

        var error = Assert.IsType<RunErrorEvent>(Assert.Single(run.Emitted));
        Assert.Equal(("The session reported an error.", "unknown_error"), (error.Message, error.Code));
    }

    [Fact]
    public async Task IgnoresARetryingSessionErrorAndCompletes()
    {
        var run = await CollectAsync([
            """{"type":"session.error","id":"err_1","error":{"type":"model_overloaded_error","message":"busy","retry_status":{"type":"retrying"}}}""",
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"ok"}]}""",
            IdleEndTurn,
        ]);

        Assert.Equal(ManagedAgentsTurnStatus.Finished, run.Outcome.Status);
    }

    [Fact]
    public async Task TreatsRetriesExhaustedAsAnErrorNotACleanFinish()
    {
        var run = await CollectAsync([
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"retries_exhausted"}}""",
        ]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        var error = Assert.IsType<RunErrorEvent>(run.Emitted[^1]);
        Assert.Equal("retries_exhausted", error.Code);
    }

    [Fact]
    public async Task ReportsATerminatedSessionAsEnded()
    {
        var run = await CollectAsync(["""{"type":"session.status_terminated","id":"term_1"}"""]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        Assert.True(run.Outcome.SessionEnded);
    }

    [Fact]
    public async Task ClosesADanglingPreviewWhenTheModelRequestEndsWithoutAMessage()
    {
        var run = await CollectAsync([
            """{"type":"event_start","event":{"type":"agent.message","id":"msg_1"}}""",
            """{"type":"event_delta","event_id":"msg_1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"partia"}}}""",
            """{"type":"span.model_request_end","id":"span_1","model_request_start_id":"s_1","is_error":true,"model_usage":{}}""",
            IdleEndTurn,
        ]);

        Assert.Equal(
            [AGUIEventTypes.TextMessageStart, AGUIEventTypes.TextMessageContent, AGUIEventTypes.TextMessageEnd],
            Types(run.Emitted));
    }

    [Fact]
    public async Task KeepsTheTopUpWhenASuccessfulSpanEndArrivesBeforeTheBufferedMessage()
    {
        // A successful model_request_end must not close the preview: the buffered
        // agent.message arrives after it and still owes the streamed text its top-up.
        var run = await CollectAsync([
            """{"type":"event_start","event":{"type":"agent.message","id":"msg_1"}}""",
            """{"type":"event_delta","event_id":"msg_1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"Hel"}}}""",
            """{"type":"span.model_request_end","id":"span_1","model_request_start_id":"s_1","is_error":false,"model_usage":{}}""",
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Hello there"}]}""",
            IdleEndTurn,
        ]);

        Assert.Equal(
            [AGUIEventTypes.TextMessageStart, AGUIEventTypes.TextMessageContent, AGUIEventTypes.TextMessageContent, AGUIEventTypes.TextMessageEnd],
            Types(run.Emitted));
        var deltas = run.Emitted.OfType<TextMessageContentEvent>().Select(static e => e.Delta).ToList();
        Assert.Equal(["Hel", "lo there"], deltas);
    }

    [Fact]
    public async Task MapsAnUnpreviewedThinkingStretchToAnEmptyReasoningPair()
    {
        var run = await CollectAsync([
            """{"type":"agent.thinking","id":"think_1"}""",
            IdleEndTurn,
        ]);

        Assert.Equal([AGUIEventTypes.ReasoningStart, AGUIEventTypes.ReasoningEnd], Types(run.Emitted));
    }

    [Fact]
    public async Task DropsAnEmptyTextDelta()
    {
        var run = await CollectAsync([
            """{"type":"event_start","event":{"type":"agent.message","id":"msg_1"}}""",
            """{"type":"event_delta","event_id":"msg_1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":""}}}""",
            """{"type":"event_delta","event_id":"msg_1","delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"Hi"}}}""",
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Hi"}]}""",
            IdleEndTurn,
        ]);

        var deltas = run.Emitted.OfType<TextMessageContentEvent>().Select(evt => evt.Delta).ToList();
        Assert.Equal(["Hi"], deltas);
    }

    [Fact]
    public async Task FlattensMixedToolResultContent()
    {
        var run = await CollectAsync([
            """
            {
              "type": "agent.tool_result",
              "id": "tr_1",
              "tool_use_id": "tu_1",
              "content": [
                {"type": "text", "text": "Caf&eacute; &amp; &#39;more&#39; &lt;b&gt;"},
                {"type": "search_result", "title": "Docs &amp; guides", "source": "https://example.com", "content": [{"type": "text", "text": "body text"}]},
                {"type": "image", "source": {}}
              ]
            }
            """,
            IdleEndTurn,
        ]);

        // The text block is literal tool output and stays verbatim; only the search result,
        // whose body is extracted from HTML, is decoded.
        var result = Assert.IsType<ToolCallResultEvent>(run.Emitted[0]);
        Assert.Equal(
            "Caf&eacute; &amp; &#39;more&#39; &lt;b&gt;\n[search result] Docs & guides — https://example.com\nbody text\n[image]",
            result.Content);
    }

    [Fact]
    public async Task AnswersTheCallWhenAHandlerThrowsItsOwnCancellation()
    {
        // A handler's own timeout (e.g. an inner HttpClient) throws an
        // OperationCanceledException while the run's token is NOT cancelled;
        // the session is still waiting on the call, so it must be answered.
        var backend = new ManagedAgentsBackendTool
        {
            Name = "get_time",
            Handler = _ => throw new TaskCanceledException("A task was canceled."),
        };
        var run = await CollectAsync(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""",
                IdleEndTurn,
            ],
            backendTools: new Dictionary<string, ManagedAgentsBackendTool> { ["get_time"] = backend });

        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"A task was canceled."}],"is_error":true}""",
            run.Fake.Sent[1].Single());
    }

    [Fact]
    public async Task ReportsABackendToolExceptionAsAnErrorResult()
    {
        var backend = new ManagedAgentsBackendTool
        {
            Name = "get_time",
            Handler = _ => throw new InvalidOperationException("clock offline"),
        };
        var run = await CollectAsync(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""",
                IdleEndTurn,
            ],
            backendTools: new Dictionary<string, ManagedAgentsBackendTool> { ["get_time"] = backend });

        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"clock offline"}],"is_error":true}""",
            run.Fake.Sent[1].Single());
        var result = run.Emitted.OfType<ToolCallResultEvent>().Single();
        Assert.Equal("clock offline", result.Content);
    }

    [Fact]
    public async Task InterruptsAndErrorsOnAnUnknownBlockingAction()
    {
        var run = await CollectAsync([
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["unknown_1"]}}""",
        ]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        Assert.Equal("unsupported_action", Assert.IsType<RunErrorEvent>(run.Emitted[^1]).Code);
        AssertJson("""{"type":"user.interrupt"}""", run.Fake.Sent[1].Single());
    }

    [Fact]
    public async Task ReportsADeletedSessionAsEnded()
    {
        var run = await CollectAsync(["""{"type":"session.deleted","id":"del_1"}"""]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        Assert.True(run.Outcome.SessionEnded);
        Assert.Equal("session_ended", Assert.IsType<RunErrorEvent>(run.Emitted[^1]).Code);
    }

    [Fact]
    public async Task ErrorsWhenTheStreamEndsBeforeTheTurnCompletes()
    {
        var run = await CollectAsync(["""{"type":"event_start","event":{"type":"agent.message","id":"msg_1"}}"""]);

        Assert.Equal(ManagedAgentsTurnStatus.Errored, run.Outcome.Status);
        // The open message is closed before the error.
        Assert.Equal(
            [AGUIEventTypes.TextMessageStart, AGUIEventTypes.TextMessageEnd, AGUIEventTypes.RunError],
            Types(run.Emitted));
        Assert.Equal("stream_ended", Assert.IsType<RunErrorEvent>(run.Emitted[^1]).Code);
    }
}
