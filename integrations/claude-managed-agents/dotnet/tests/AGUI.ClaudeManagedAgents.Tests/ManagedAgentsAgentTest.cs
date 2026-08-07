using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsAgentTest
{
    private const string IdleEndTurn =
        """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"end_turn"}}""";

    /// <summary>
    /// The key the store and the busy gate share: scoped to the managed agent, not the bare
    /// (client-supplied) thread id.
    /// </summary>
    private const string SessionKey = "7:agent_1|0:|5:env_1|0:|thread_1";

    private static ManagedAgentsAgent NewAgent(FakeManagedAgentsClient fake, ISessionStore? store = null, Action<ManagedAgentsAgentOptions>? configure = null)
    {
        var options = new ManagedAgentsAgentOptions
        {
            ManagedAgentId = "agent_1",
            EnvironmentId = "env_1",
            Client = fake,
            SessionStore = store,
        };
        configure?.Invoke(options);
        return new ManagedAgentsAgent(options);
    }

    private static ManagedAgentsSessionRecord Record(IList<string> pending, string? lastUserMessageId = "u1")
    {
        return new ManagedAgentsSessionRecord { SessionId = "sesn_1", ToolNames = [], PendingClientToolUseIds = pending, LastUserMessageId = lastUserMessageId };
    }

    private static RunAgentInput BaseInput(Action<RunAgentInput>? configure = null)
    {
        var input = new RunAgentInput
        {
            ThreadId = "thread_1",
            RunId = "run_1",
            State = JsonSerializer.SerializeToElement(new { }),
            Messages = [new AGUIUserMessage { Id = "u1", Content = "Hello" }],
            Tools = [],
        };
        configure?.Invoke(input);
        return input;
    }

    private static async Task<List<BaseEvent>> CollectAsync(ManagedAgentsAgent agent, RunAgentInput input)
    {
        var events = new List<BaseEvent>();
        await foreach (var evt in agent.RunAsync(input))
        {
            events.Add(evt);
        }

        return events;
    }

    private static IEnumerable<string> Types(IEnumerable<BaseEvent> events) => events.Select(e => e.Type);

    private static AGUITool Tool(string name, string description, string parametersJson)
    {
        return new AGUITool
        {
            Name = name,
            Description = description,
            Parameters = FakeManagedAgentsClient.Json(parametersJson),
        };
    }

    private static void AssertJson(string expected, JsonElement actual)
    {
        var expectedElement = FakeManagedAgentsClient.Json(expected);
        Assert.True(
            JsonElement.DeepEquals(expectedElement, actual),
            $"Expected {expectedElement.GetRawText()}\nActual   {actual.GetRawText()}");
    }

    [Fact]
    public async Task CreatesASessionForANewThreadAndStreamsAReply()
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Hi!"}]}""",
            IdleEndTurn,
        ]);

        var events = await CollectAsync(NewAgent(fake), BaseInput());

        var created = Assert.Single(fake.CreatedSessions);
        Assert.Equal(("agent_1", "env_1", "AG-UI thread thread_1"), (created.ManagedAgentId, created.EnvironmentId, created.Title));
        Assert.Null(created.OverrideTools);

        Assert.Equal(
            [
                AGUIEventTypes.RunStarted,
                AGUIEventTypes.StateSnapshot,
                AGUIEventTypes.Custom,
                AGUIEventTypes.TextMessageStart,
                AGUIEventTypes.TextMessageContent,
                AGUIEventTypes.TextMessageEnd,
                AGUIEventTypes.RunFinished,
            ],
            Types(events));

        var custom = Assert.IsType<CustomEvent>(events[2]);
        Assert.Equal(ManagedAgentsAgent.SessionCustomEventName, custom.Name);
        AssertJson("""{"sessionId":"sesn_1","threadId":"thread_1"}""", custom.Value!.Value);
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"Hello"}]}""", fake.Sent[0].Single());
    }

    [Fact]
    public async Task ReusesTheSessionOnTheThreadsNextRunAndSendsOnlyTheNewMessage()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"one"}]}""", IdleEndTurn],
            ["""{"type":"agent.message","id":"msg_2","content":[{"type":"text","text":"two"}]}""", IdleEndTurn]);
        var store = new InMemorySessionStore();

        await CollectAsync(NewAgent(fake, store), BaseInput());
        await CollectAsync(NewAgent(fake, store), BaseInput(input =>
        {
            input.RunId = "run_2";
            input.Messages =
            [
                new AGUIUserMessage { Id = "u1", Content = "Hello" },
                new AGUIAssistantMessage { Id = "a1", Content = "one" },
                new AGUIUserMessage { Id = "u2", Content = "Follow-up" },
            ];
        }));

        Assert.Single(fake.CreatedSessions);
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"Follow-up"}]}""", fake.Sent[1].Single());
    }

    [Fact]
    public async Task DedupesRegisteredToolsAgainstTheAgentsOwnCustomTools()
    {
        // A custom tool already defined on the managed agent must not be sent
        // twice when a frontend tool of the same name is registered: the
        // frontend definition wins and the agent's copy is dropped.
        var fake = new FakeManagedAgentsClient([IdleEndTurn])
        {
            AgentTools =
            [
                FakeManagedAgentsClient.Json("""{"type":"agent_toolset_20260401","configs":[],"default_config":{}}"""),
                FakeManagedAgentsClient.Json("""{"type":"custom","name":"show_chart","description":"Agent's own copy","input_schema":{"type":"object","properties":{}}}"""),
            ],
        };

        await CollectAsync(NewAgent(fake), BaseInput(input =>
            input.Tools = [Tool("show_chart", "Render a chart", """{"type":"object","properties":{}}""")]));

        var created = Assert.Single(fake.CreatedSessions);
        var tools = Assert.IsAssignableFrom<IList<JsonElement>>(created.OverrideTools);
        Assert.Equal(2, tools.Count);
        AssertJson("""{"type":"agent_toolset_20260401","configs":[],"default_config":{}}""", tools[0]);
        Assert.Equal("Render a chart", tools[1].GetProperty("description").GetString());
    }

    [Fact]
    public async Task RegistersFrontendToolsAsCustomToolsWhenCreatingTheSession()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);

        await CollectAsync(NewAgent(fake), BaseInput(input =>
            input.Tools = [Tool("show_chart", "Render a chart", """{"type":"object","properties":{"title":{"type":"string"}}}""")]));

        var created = Assert.Single(fake.CreatedSessions);
        var tools = Assert.IsAssignableFrom<IList<JsonElement>>(created.OverrideTools);
        Assert.Equal(2, tools.Count);
        AssertJson("""{"type":"agent_toolset_20260401","configs":[],"default_config":{}}""", tools[0]);
        AssertJson(
            """
            {
              "type": "custom",
              "name": "show_chart",
              "description": "Render a chart",
              "input_schema": {"type": "object", "properties": {"title": {"type": "string"}}}
            }
            """,
            tools[1]);
    }

    [Fact]
    public async Task RoundTripsAFrontendToolByParkingThenResumingWithTheClientsResult()
    {
        var fake = new FakeManagedAgentsClient(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"show_chart","input":{"title":"Sales"}}""",
                """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["ctu_1"]}}""",
            ],
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Chart shown."}]}""", IdleEndTurn]);
        var store = new InMemorySessionStore();
        var tools = new List<AGUITool> { Tool("show_chart", "Render a chart", """{"type":"object"}""") };

        var first = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Tools = tools));
        Assert.Equal(
            [
                AGUIEventTypes.RunStarted,
                AGUIEventTypes.StateSnapshot,
                AGUIEventTypes.Custom,
                AGUIEventTypes.ToolCallStart,
                AGUIEventTypes.ToolCallArgs,
                AGUIEventTypes.ToolCallEnd,
                AGUIEventTypes.RunFinished,
            ],
            Types(first));
        Assert.Equal(["ctu_1"], (await store.GetAsync(SessionKey, default))!.PendingClientToolUseIds);

        var second = await CollectAsync(NewAgent(fake, store), BaseInput(input =>
        {
            input.RunId = "run_2";
            input.Tools = tools;
            input.Messages =
            [
                new AGUIUserMessage { Id = "u1", Content = "Hello" },
                new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "rendered" },
            ];
        }));

        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"rendered"}],"is_error":false}""",
            fake.Sent[1].Single());
        Assert.Contains(AGUIEventTypes.TextMessageContent, Types(second));
        Assert.Equal(AGUIEventTypes.RunFinished, second[^1].Type);
        Assert.Empty((await store.GetAsync(SessionKey, default))!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task SharesTheDefaultSessionStoreAcrossRunsSoAResumedRunFindsItsParkedSession()
    {
        var fake = new FakeManagedAgentsClient(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"show_chart","input":{}}""",
                """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["ctu_1"]}}""",
            ],
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Done."}]}""", IdleEndTurn]);
        // No session store passed: the default in-memory store persists across runs.
        var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions { ManagedAgentId = "agent_1", EnvironmentId = "env_1", Client = fake });
        var tools = new List<AGUITool> { Tool("show_chart", "Render a chart", """{"type":"object"}""") };

        await CollectAsync(agent, BaseInput(input => input.Tools = tools));
        await CollectAsync(agent, BaseInput(input =>
        {
            input.RunId = "run_2";
            input.Tools = tools;
            input.Messages =
            [
                new AGUIUserMessage { Id = "u1", Content = "Hello" },
                new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "rendered" },
            ];
        }));

        Assert.Single(fake.CreatedSessions);
        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"rendered"}],"is_error":false}""",
            fake.Sent[1].Single());
    }

    [Fact]
    public async Task ForwardsEveryUndeliveredUserMessageInOrder()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new InMemorySessionStore();
        await store.SetAsync(
            SessionKey,
            new ManagedAgentsSessionRecord { SessionId = "sesn_1", ToolNames = [], PendingClientToolUseIds = [], LastUserMessageId = "u1" },
            default);

        await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "delivered" },
            new AGUIUserMessage { Id = "u2", Content = "second" },
            new AGUIUserMessage { Id = "u3", Content = "third" },
        ]));

        var sent = fake.Sent[0];
        Assert.Equal(2, sent.Count);
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"second"}]}""", sent[0]);
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"third"}]}""", sent[1]);
        Assert.Equal("u3", (await store.GetAsync(SessionKey, default))!.LastUserMessageId);
    }

    [Fact]
    public async Task AbandonsParkedToolCallsWhenTheUserSendsANewMessageInstead()
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Moving on."}]}""",
            IdleEndTurn,
        ]);
        var store = new InMemorySessionStore();
        await store.SetAsync(
            SessionKey,
            new ManagedAgentsSessionRecord { SessionId = "sesn_1", ToolNames = [], PendingClientToolUseIds = ["ctu_1"], LastUserMessageId = "u1" },
            default);

        var events = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "old" },
            new AGUIUserMessage { Id = "u2", Content = "never mind" },
        ]));

        // The abandoned result is posted first (resuming the parked session), then the user
        // message follows in a second call: the API rejects the two mixed in one batch.
        Assert.Equal(2, fake.Sent.Count);
        AssertJson(
            """
            {
              "type": "user.custom_tool_result",
              "custom_tool_use_id": "ctu_1",
              "content": [{"type": "text", "text": "The user did not provide a result for this tool call."}],
              "is_error": true
            }
            """,
            fake.Sent[0].Single());
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"never mind"}]}""", fake.Sent[1].Single());
        Assert.Equal(AGUIEventTypes.RunFinished, events[^1].Type);

        var record = (await store.GetAsync(SessionKey, default))!;
        Assert.Empty(record.PendingClientToolUseIds);
        Assert.Equal("u2", record.LastUserMessageId);
    }

    [Fact]
    public async Task ErrorsWhenARunHasNothingNewToSend()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new InMemorySessionStore();
        await store.SetAsync(
            SessionKey,
            new ManagedAgentsSessionRecord { SessionId = "sesn_1", ToolNames = [], PendingClientToolUseIds = [], LastUserMessageId = "u1" },
            default);

        var events = await CollectAsync(NewAgent(fake, store), BaseInput());

        Assert.Equal("nothing_to_send", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task ErrorsWithoutTouchingTheApiWhenARunHasNoUserMessageOrToolResult()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);

        var events = await CollectAsync(NewAgent(fake), BaseInput(input => input.Messages = []));

        Assert.Equal([AGUIEventTypes.RunStarted, AGUIEventTypes.StateSnapshot, AGUIEventTypes.RunError], Types(events));
        Assert.Equal("empty_run", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.CreatedSessions);
    }

    [Fact]
    public async Task ReleasesTheThreadGateWhenABadInputFailsTheRun()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"ok"}]}""", IdleEndTurn]);
        var agent = NewAgent(fake);

        // A null message list must not leak the busy gate before the run fails.
        var bad = await CollectAsync(agent, BaseInput(input => input.Messages = null!));
        Assert.Equal("empty_run", Assert.IsType<RunErrorEvent>(bad[^1]).Code);

        var good = await CollectAsync(agent, BaseInput());
        Assert.Equal(AGUIEventTypes.RunFinished, good[^1].Type);
    }

    [Fact]
    public async Task RetriesTheFollowUpUserMessageWhileTheSessionIsStillParked()
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"Moving on."}]}""",
            IdleEndTurn,
        ]);
        var store = new InMemorySessionStore();
        await store.SetAsync(
            SessionKey,
            new ManagedAgentsSessionRecord { SessionId = "sesn_1", ToolNames = [], PendingClientToolUseIds = ["ctu_1"], LastUserMessageId = "u1" },
            default);

        // The result posts fine; the follow-up user message races the un-park and is rejected
        // twice as sent-while-parked before the session accepts it.
        var parked = new ManagedAgentsSendException(400, "session is waiting on responses to events [ctu_1]");
        var rejections = 0;
        fake.SendGuard = batch =>
        {
            var isFollowUp = batch.Any(e => e.GetProperty("type").GetString() == "user.message");
            return isFollowUp && rejections++ < 2 ? parked : null;
        };

        var events = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "old" },
            new AGUIUserMessage { Id = "u2", Content = "never mind" },
        ]));

        // One results batch, then the user message: two rejected attempts plus one success.
        Assert.Equal(4, fake.SendAttempts.Count);
        Assert.Equal(2, fake.Sent.Count);
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"never mind"}]}""", fake.Sent[1].Single());
        Assert.Equal(AGUIEventTypes.RunFinished, events[^1].Type);
    }

    [Fact]
    public async Task RetriesTheParkedRaceWhenTheRealSdkClientThrows()
    {
        // The default client throws Anthropic's own AnthropicApiException, not
        // ManagedAgentsSendException, so this covers the branch that actually runs in
        // production. Note AnthropicApiException.Message is synthesised from StatusCode +
        // ResponseBody and ignores the constructor message — the parked wording therefore has
        // to be in the response body, exactly as the API returns it.
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new InMemorySessionStore();
        await store.SetAsync(
            SessionKey,
            new ManagedAgentsSessionRecord { SessionId = "sesn_1", ToolNames = [], PendingClientToolUseIds = ["ctu_1"], LastUserMessageId = "u1" },
            default);

        const string Body = """{"type":"error","error":{"type":"invalid_request_error","message":"session is waiting on responses to events [ctu_1]"}}""";
        var parked = new Anthropic.Exceptions.AnthropicApiException(
            "bad request",
            new System.Net.Http.HttpRequestException("bad request", null, System.Net.HttpStatusCode.BadRequest))
        {
            StatusCode = System.Net.HttpStatusCode.BadRequest,
            ResponseBody = Body,
        };

        var rejections = 0;
        fake.SendGuard = batch =>
        {
            var isFollowUp = batch.Any(e => e.GetProperty("type").GetString() == "user.message");
            return isFollowUp && rejections++ < 2 ? parked : null;
        };

        var events = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "old" },
            new AGUIUserMessage { Id = "u2", Content = "never mind" },
        ]));

        Assert.Equal(4, fake.SendAttempts.Count);
        Assert.Equal(2, fake.Sent.Count);
        Assert.Equal(AGUIEventTypes.RunFinished, events[^1].Type);
    }

    [Fact]
    public async Task AgentsDifferingOnlyInEnvironmentDoNotShareASession()
    {
        // EnvironmentId and AgentVersion are baked into the remote session at creation and can
        // never be checked or changed on resume, so a key scoped only by managed agent let a
        // staging and a production agent on one store share a session: every prod turn would then
        // execute in staging, with nothing surfaced to say so.
        var staging = new FakeManagedAgentsClient([IdleEndTurn]) { SessionId = "sesn_staging" };
        var prod = new FakeManagedAgentsClient([IdleEndTurn]) { SessionId = "sesn_prod" };
        var store = new RecordingSessionStore();

        await CollectAsync(NewAgent(staging, store, o => o.EnvironmentId = "env_staging"), BaseInput());
        await CollectAsync(NewAgent(prod, store, o => o.EnvironmentId = "env_prod"), BaseInput());

        Assert.Single(staging.CreatedSessions);
        Assert.Single(prod.CreatedSessions);
        Assert.Equal(
            ["7:agent_1|0:|11:env_staging|0:|thread_1", "7:agent_1|0:|8:env_prod|0:|thread_1"],
            store.Keys.Order());
    }

    [Fact]
    public async Task EmitsOneTerminalEventWhenTheClosingWriteFails()
    {
        // Regression: the turn already emitted RUN_ERROR, then persisting the outcome failed and
        // the outer catch appended a second terminal event.
        var fake = new FakeManagedAgentsClient(["""{"type":"session.status_terminated","id":"term_1"}"""]);
        var store = new FailingDeleteStore();
        var reported = new List<string>();

        var events = await CollectAsync(
            NewAgent(fake, store, o => o.OnError = (_, context) => { reported.Add(context.Operation); return Task.CompletedTask; }),
            BaseInput());

        var terminal = events.Where(static e => e is RunErrorEvent or RunFinishedEvent).ToList();
        Assert.Equal("session_ended", Assert.IsType<RunErrorEvent>(Assert.Single(terminal)).Code);
        // The dropped error is not lost: it reaches the hook.
        Assert.Contains("dropped_terminal_event", reported);
    }

    private sealed class FailingDeleteStore : ISessionStore
    {
        private readonly RecordingSessionStore _inner = new();

        public ValueTask<ManagedAgentsSessionRecord?> GetAsync(string threadKey, CancellationToken cancellationToken)
            => _inner.GetAsync(threadKey, cancellationToken);

        public ValueTask SetAsync(string threadKey, ManagedAgentsSessionRecord record, CancellationToken cancellationToken)
            => _inner.SetAsync(threadKey, record, cancellationToken);

        public ValueTask DeleteAsync(string threadKey, CancellationToken cancellationToken)
            => ValueTask.FromException(new InvalidOperationException("store is down"));
    }

    [Fact]
    public async Task AttachesConfiguredVaultIdsToTheCreatedSession()
    {
        // Parity with the TypeScript `vaultIds` and Python `vault_ids` options. The .NET port
        // omitted this, and the README blamed a missing SDK field that in fact exists on the
        // pinned Anthropic 12.37.0 SessionCreateParams.
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var agent = NewAgent(fake, new RecordingSessionStore(), options =>
        {
            options.VaultIds.Add("vlt_one");
            options.VaultIds.Add("vlt_two");
        });

        await CollectAsync(agent, BaseInput());

        Assert.Equal(["vlt_one", "vlt_two"], Assert.Single(fake.CreatedSessions).VaultIds);
    }

    [Fact]
    public async Task LeavesVaultIdsUnsetWhenNoneAreConfigured()
    {
        // Sent as absent rather than an empty list, so the payload matches the other two ports.
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var agent = NewAgent(fake, new RecordingSessionStore());

        await CollectAsync(agent, BaseInput());

        Assert.Null(Assert.Single(fake.CreatedSessions).VaultIds);
    }

    [Fact]
    public async Task TwoAgentsSharingAStoreNeverAdoptEachOthersSession()
    {
        // Regression: the busy gate was scoped by managed agent while the store was keyed by the
        // bare thread id, so a second agent on the same thread id read the first agent's session —
        // a session created against a different managed agent — without serializing against it.
        var first = new FakeManagedAgentsClient([IdleEndTurn]) { SessionId = "sesn_first" };
        var second = new FakeManagedAgentsClient([IdleEndTurn]) { SessionId = "sesn_second" };
        var store = new RecordingSessionStore();

        await CollectAsync(NewAgent(first, store, o => o.ManagedAgentId = "agent_a"), BaseInput());
        await CollectAsync(
            NewAgent(second, store, o => o.ManagedAgentId = "agent_b"),
            BaseInput(input => input.RunId = "run_2"));

        Assert.Single(first.CreatedSessions);
        Assert.Single(second.CreatedSessions);
        Assert.Equal(["7:agent_a|0:|5:env_1|0:|thread_1", "7:agent_b|0:|5:env_1|0:|thread_1"], store.Keys.Order());
        Assert.Equal("sesn_first", (await store.GetAsync("7:agent_a|0:|5:env_1|0:|thread_1", default))!.SessionId);
        Assert.Equal("sesn_second", (await store.GetAsync("7:agent_b|0:|5:env_1|0:|thread_1", default))!.SessionId);
    }

    [Fact]
    public async Task RunsSerializeOnTheSameKeyTheStoreUses()
    {
        var gate = new TaskCompletionSource();
        var fake = new FakeManagedAgentsClient([IdleEndTurn]) { Gate = gate };
        var store = new RecordingSessionStore();
        var agent = NewAgent(fake, store);

        var events = agent.RunAsync(BaseInput()).GetAsyncEnumerator();
        await using var scope = events.ConfigureAwait(false);
        // Advance far enough to create the session and open the stream.
        while (await events.MoveNextAsync() && events.Current is not CustomEvent)
        {
            // keep going
        }

        Assert.Equal([SessionKey], store.Keys);
        // The point of the commit: the gate and the store must agree on the key. Asserting only
        // store.Keys made this a duplicate of KeysTheSessionStoreByThreadId, so re-splitting the
        // two keys in this port alone would have gone unnoticed.
        Assert.Equal([SessionKey], ManagedAgentsAgent.BusyKeysFor(store));

        gate.SetResult();
        while (await events.MoveNextAsync())
        {
            // drain
        }
    }

    private const string ParkingCall =
        """{"type":"agent.custom_tool_use","id":"ctu_1","name":"show_chart","input":{}}""";

    private static AGUITool ShowChartTool() => Tool("show_chart", "Render a chart", """{"type":"object"}""");

    [Fact]
    public async Task KeepsAParkedToolIdWhenALaterSessionEventFailsTheTurn()
    {
        // Regression: the session has already parked on ctu_1 by the time the error arrives.
        // Without the id the next run cannot answer that call, so the remote session stays
        // parked forever.
        var fake = new FakeManagedAgentsClient([
            ParkingCall,
            """{"type":"session.error","id":"err_1","error":{"type":"overloaded_error","message":"upstream is busy","retry_status":{"type":"exhausted"}}}""",
        ]);
        var store = new RecordingSessionStore();

        var events = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Tools = [ShowChartTool()]));

        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal("overloaded_error", error.Code);
        var record = await store.GetAsync(SessionKey, default);
        Assert.Equal(["ctu_1"], record!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task KeepsAParkedToolIdWhenTheStreamThrowsAfterThePark()
    {
        var fake = new FakeManagedAgentsClient([ParkingCall])
        {
            StreamFailure = new InvalidOperationException("connection reset"),
        };
        var store = new RecordingSessionStore();

        var events = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Tools = [ShowChartTool()]));

        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal("run_failed", error.Code);
        var record = await store.GetAsync(SessionKey, default);
        Assert.Equal(["ctu_1"], record!.PendingClientToolUseIds);
    }

    private static readonly string[] s_parkedThenUnknownAction =
    [
        ParkingCall,
        """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["ctu_1","mystery_1"]}}""",
    ];

    [Fact]
    public async Task ForgetsAParkedCallOnceTheTurnsInterruptHasLanded()
    {
        // Regression: the park is persisted the moment the call is handed over, then the turn
        // interrupts the session and fails. The interrupt cancels the wait, so answering that id on
        // the next run is rejected as stale and wedges the thread — it must not survive.
        var fake = new FakeManagedAgentsClient(s_parkedThenUnknownAction);
        var store = new RecordingSessionStore();

        var events = await CollectAsync(
            NewAgent(fake, store),
            BaseInput(input => input.Tools = [ShowChartTool()]));

        Assert.Equal("unsupported_action", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Contains("user.interrupt", fake.SentTypes);
        var record = await store.GetAsync(SessionKey, default);
        Assert.Empty(record!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task KeepsAParkedCallWhenTheTurnsInterruptCouldNotBeDelivered()
    {
        // The mirror image: nothing reached the session, so it may still be parked and the id is
        // still the only way to answer it.
        var fake = new FakeManagedAgentsClient(s_parkedThenUnknownAction)
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.interrupt")
                ? new InvalidOperationException("interrupt rejected")
                : null,
        };
        var store = new RecordingSessionStore();

        var events = await CollectAsync(
            NewAgent(fake, store),
            BaseInput(input => input.Tools = [ShowChartTool()]));

        Assert.Equal("unsupported_action", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        var record = await store.GetAsync(SessionKey, default);
        Assert.Equal(["ctu_1"], record!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task ForgetsAParkedCallOnceTheTeardownInterruptHasLanded()
    {
        // A cancelled turn never reaches RecordOutcomeAsync, so the teardown path has to reconcile
        // the record itself.
        var fake = new FakeManagedAgentsClient([ParkingCall]);
        var store = new RecordingSessionStore();
        using var client = new CancellationTokenSource();
        var agent = NewAgent(fake, store);

        // Cancel once the park has been recorded, so the turn unwinds mid-flight.
        var events = new List<BaseEvent>();
        try
        {
            await foreach (var evt in agent.RunAsync(
                BaseInput(input => input.Tools = [ShowChartTool()]), client.Token))
            {
                events.Add(evt);
                if (evt is ToolCallEndEvent)
                {
                    await client.CancelAsync();
                }
            }
        }
        catch (OperationCanceledException)
        {
            // expected: the caller left
        }

        Assert.Contains("user.interrupt", fake.SentTypes);
        var record = await store.GetAsync(SessionKey, default);
        Assert.Empty(record!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task ClearsAStaleParkedIdWhenTheSessionGoesIdleOnEndTurn()
    {
        // Defensive: end_turn means nothing is awaited, so no pending id may survive into the
        // next run and be answered against a resumed session.
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new RecordingSessionStore();
        await store.SetAsync(SessionKey, Record(["ctu_stale"]), default);

        await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "Hello" },
            new AGUIUserMessage { Id = "u2", Content = "never mind" },
        ]));

        var record = await store.GetAsync(SessionKey, default);
        Assert.Empty(record!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task ClearsPendingToolIdsEvenWhenTheFollowUpSendThenFails()
    {
        // Regression: once the tool results resume the session they are recorded as delivered,
        // even if the follow-up messages then fail. Re-posting a consumed result on the next run
        // would be rejected by the API and leave the thread wedged. Asserted against an
        // out-of-process-shaped store so only genuinely persisted state counts.
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new RecordingSessionStore();
        await store.SetAsync(SessionKey, Record(["ctu_1"]), default);
        store.Writes.Clear();

        fake.SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.message")
            ? new InvalidOperationException("server exploded")
            : null;

        var events = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "Hello" },
            new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "done" },
            new AGUIUserMessage { Id = "u2", Content = "and one more thing" },
        ]));

        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal((ManagedAgentsAgent.RunFailedMessage, "run_failed"), (error.Message, error.Code));

        var record = await store.GetAsync(SessionKey, default);
        Assert.NotNull(record);
        Assert.Empty(record!.PendingClientToolUseIds);
        // The follow-up never landed, so the user message stays undelivered.
        Assert.Equal("u1", record.LastUserMessageId);
    }

    [Fact]
    public async Task RecordsTheFollowUpDeliverySeparatelyFromTheToolResults()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new RecordingSessionStore();
        await store.SetAsync(SessionKey, Record(["ctu_1"]), default);
        store.Writes.Clear();

        await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "Hello" },
            new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "done" },
            new AGUIUserMessage { Id = "u2", Content = "and one more thing" },
        ]));

        // Two persists: one per delivery, in send order.
        Assert.Equal(2, store.Writes.Count);
        Assert.Empty(store.Writes[0].Record.PendingClientToolUseIds);
        Assert.Equal("u1", store.Writes[0].Record.LastUserMessageId);
        Assert.Equal("u2", store.Writes[1].Record.LastUserMessageId);
    }

    [Fact]
    public async Task RejectsABlankThreadIdInsteadOfSharingOneSessionAcrossCallers()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new RecordingSessionStore();

        foreach (var threadId in new[] { string.Empty, "   " })
        {
            var events = await CollectAsync(
                NewAgent(fake, store),
                BaseInput(input => input.ThreadId = threadId));
            Assert.Equal("invalid_thread_id", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        }

        Assert.Empty(fake.CreatedSessions);
        Assert.Empty(store.Keys);
    }

    [Fact]
    public async Task ErrorsWithoutCreatingASessionWhenAFreshThreadCarriesOnlyAToolResult()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);

        var events = await CollectAsync(NewAgent(fake), BaseInput(input =>
            input.Messages = [new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "rendered" }]));

        Assert.Equal([AGUIEventTypes.RunStarted, AGUIEventTypes.StateSnapshot, AGUIEventTypes.RunError], Types(events));
        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal(
            ("There is nothing to send: a tool result arrived for a thread with no session.", "tool_result_without_session"),
            (error.Message, error.Code));
        Assert.Empty(fake.CreatedSessions);
        Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task UpdatesTheSessionsToolsWhenTheFrontendAddsANewOne()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn], [IdleEndTurn]);
        var store = new InMemorySessionStore();

        await CollectAsync(NewAgent(fake, store), BaseInput());
        Assert.Empty(fake.Updates);

        await CollectAsync(NewAgent(fake, store), BaseInput(input =>
        {
            input.RunId = "run_2";
            input.Messages =
            [
                new AGUIUserMessage { Id = "u1", Content = "Hello" },
                new AGUIUserMessage { Id = "u2", Content = "Show me a chart" },
            ];
            input.Tools = [Tool("show_chart", "Render a chart", """{"type":"object"}""")];
        }));

        var update = Assert.Single(fake.Updates);
        Assert.Equal(2, update.Count);
        AssertJson("""{"type":"agent_toolset_20260401","configs":[],"default_config":{}}""", update[0]);
        AssertJson(
            """{"type":"custom","name":"show_chart","description":"Render a chart","input_schema":{"type":"object"}}""",
            update[1]);
    }

    [Fact]
    public async Task RejectsASecondRunWhileTheThreadIsBusy()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"slow"}]}""", IdleEndTurn]);
        fake.Gate = new TaskCompletionSource();
        var store = new InMemorySessionStore();
        var agent = NewAgent(fake, store);

        // Start a run and drive it into the turn, which blocks on the gate mid-stream.
        await using var slow = agent.RunAsync(BaseInput()).GetAsyncEnumerator();
        Assert.True(await slow.MoveNextAsync());
        Assert.Equal(AGUIEventTypes.RunStarted, slow.Current.Type);
        Assert.True(await slow.MoveNextAsync());
        Assert.Equal(AGUIEventTypes.StateSnapshot, slow.Current.Type);
        var pending = slow.MoveNextAsync(); // creates the session, then blocks in the turn stream

        // Give the first run time to enter the busy section.
        await Task.Delay(100);
        var second = await CollectAsync(agent, BaseInput(input => input.RunId = "run_2"));
        var error = Assert.IsType<RunErrorEvent>(second[^1]);
        Assert.Equal(("A run is already in progress on this thread.", "run_in_progress"), (error.Message, error.Code));

        fake.Gate.SetResult();
        await pending;
        while (await slow.MoveNextAsync())
        {
        }
    }

    [Fact]
    public async Task RejectsASecondRunOnTheSameThreadFromAnotherAgentInstance()
    {
        // The busy gate is shared across instances, so per-request construction
        // (e.g. one agent per HTTP request) still serializes runs on a thread.
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"slow"}]}""", IdleEndTurn]);
        fake.Gate = new TaskCompletionSource();
        var store = new InMemorySessionStore();
        var first = NewAgent(fake, store);
        var second = NewAgent(new FakeManagedAgentsClient([IdleEndTurn]), store);

        await using var slow = first.RunAsync(BaseInput()).GetAsyncEnumerator();
        Assert.True(await slow.MoveNextAsync());
        Assert.True(await slow.MoveNextAsync());
        var pending = slow.MoveNextAsync();
        await Task.Delay(100);

        var events = await CollectAsync(second, BaseInput(input => input.RunId = "run_2"));
        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal("run_in_progress", error.Code);

        fake.Gate.SetResult();
        await pending;
        while (await slow.MoveNextAsync())
        {
        }
    }

    [Fact]
    public async Task DoesNotRejectRunsOnTheSameThreadIdAcrossDifferentStores()
    {
        // The busy gate is keyed by store identity: distinct stores are distinct
        // tenants, so one caller's slow run cannot block another's thread of the
        // same (client-supplied) id.
        var slowFake = new FakeManagedAgentsClient(
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"slow"}]}""", IdleEndTurn]);
        slowFake.Gate = new TaskCompletionSource();
        var first = NewAgent(slowFake, new InMemorySessionStore());
        var second = NewAgent(new FakeManagedAgentsClient([IdleEndTurn]), new InMemorySessionStore());

        await using var slow = first.RunAsync(BaseInput()).GetAsyncEnumerator();
        Assert.True(await slow.MoveNextAsync());
        Assert.True(await slow.MoveNextAsync());
        var pending = slow.MoveNextAsync();
        await Task.Delay(100);

        var events = await CollectAsync(second, BaseInput(input => input.RunId = "run_2"));
        Assert.IsType<RunFinishedEvent>(events[^1]);

        slowFake.Gate.SetResult();
        await pending;
        while (await slow.MoveNextAsync())
        {
        }
    }

    [Fact]
    public async Task KeysTheSessionStoreByThreadId()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"a"}]}""", IdleEndTurn]);
        var store = new InMemorySessionStore();
        var agent = NewAgent(fake, store);

        await foreach (var _ in agent.RunAsync(BaseInput()))
        {
        }

        Assert.Single(fake.CreatedSessions);
        Assert.NotNull(await store.GetAsync(SessionKey, default));
    }

    [Fact]
    public async Task PinsTheAgentVersionAndUsesTheConfiguredTitle()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);

        await CollectAsync(
            NewAgent(fake, configure: options =>
            {
                options.AgentVersion = 3;
                options.SessionTitle = threadId => $"Chat {threadId}";
            }),
            BaseInput());

        var created = Assert.Single(fake.CreatedSessions);
        Assert.Equal((3, "Chat thread_1"), (created.AgentVersion, created.Title));
    }

    [Fact]
    public async Task RegistersBackendAndFrontendToolsWithTheFrontendWinningANameCollision()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        fake.AgentTools = [];
        var agent = NewAgent(fake, configure: options => options.BackendTools.Add(new ManagedAgentsBackendTool
        {
            Name = "lookup docs",
            Description = "Backend lookup",
            Handler = static _ => Task.FromResult("x"),
        }));

        await CollectAsync(agent, BaseInput(input =>
            input.Tools = [Tool("lookup docs", "Frontend lookup", """{"type":"object"}""")]));

        // Both normalize to "lookup_docs"; the frontend definition wins.
        var tools = Assert.Single(fake.CreatedSessions).OverrideTools!;
        AssertJson(
            """{"type":"custom","name":"lookup_docs","description":"Frontend lookup","input_schema":{"type":"object"}}""",
            Assert.Single(tools));
    }

    [Fact]
    public async Task LetsALaterBackendToolReplaceAnEarlierOneWithTheSameNormalizedName()
    {
        var fake = new FakeManagedAgentsClient(
            [
                """{"type":"agent.custom_tool_use","id":"ctu_1","name":"search_web","input":{}}""",
                """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["ctu_1"]}}""",
                IdleEndTurn,
            ]);
        fake.AgentTools = [];

        // "search.web" and "search_web" both normalize to "search_web": constructing the
        // agent must not throw, and the last registration wins.
        var agent = NewAgent(fake, configure: options =>
        {
            options.BackendTools.Add(new ManagedAgentsBackendTool { Name = "search.web", Handler = static _ => Task.FromResult("first") });
            options.BackendTools.Add(new ManagedAgentsBackendTool { Name = "search_web", Handler = static _ => Task.FromResult("second") });
        });

        var events = await CollectAsync(agent, BaseInput());

        Assert.Single(Assert.Single(fake.CreatedSessions).OverrideTools!);
        var result = Assert.Single(events.OfType<ToolCallResultEvent>());
        Assert.Equal("second", result.Content);
    }

    [Fact]
    public async Task ForwardsAToolMessagesErrorFlagAsAnErrorResult()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new InMemorySessionStore();
        await store.SetAsync(SessionKey, Record(["ctu_1"]), default);

        await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "Hello" },
            new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "boom", Error = "failed" },
        ]));

        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"boom\nfailed"}],"is_error":true}""",
            fake.Sent[0].Single());
    }

    [Fact]
    public async Task SendsOnlyTheErrorTextWhenAToolMessageHasNoContent()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new InMemorySessionStore();
        await store.SetAsync(SessionKey, Record(["ctu_1"]), default);

        await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "Hello" },
            new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "", Error = "failed" },
        ]));

        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"failed"}],"is_error":true}""",
            fake.Sent[0].Single());
    }

    [Fact]
    public async Task StaysParkedWhenOnlySomePendingToolCallsAreAnswered()
    {
        var fake = new FakeManagedAgentsClient();
        var store = new InMemorySessionStore();
        await store.SetAsync(SessionKey, Record(["ctu_1", "ctu_2"]), default);

        var events = await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "Hello" },
            new AGUIToolMessage { Id = "t1", ToolCallId = "ctu_1", Content = "done" },
        ]));

        // The answered call is posted, the run finishes without streaming, and the unanswered
        // call stays pending.
        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"done"}],"is_error":false}""",
            Assert.Single(fake.Sent).Single());
        Assert.Empty(fake.StreamRequests);
        Assert.Equal(AGUIEventTypes.RunFinished, events[^1].Type);
        Assert.Equal(["ctu_2"], (await store.GetAsync(SessionKey, default))!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task DeletesTheThreadRecordWhenTheSessionEndsSoTheNextRunStartsFresh()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"session.status_terminated","id":"term_1"}"""],
            [IdleEndTurn]);
        var store = new InMemorySessionStore();

        var events = await CollectAsync(NewAgent(fake, store), BaseInput());
        Assert.Equal("session_ended", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Null(await store.GetAsync(SessionKey, default));

        // The next run creates a fresh session.
        await CollectAsync(NewAgent(fake, store), BaseInput(input => input.RunId = "run_2"));
        Assert.Equal(2, fake.CreatedSessions.Count);
    }

    [Fact]
    public async Task InterruptsTheSessionAndStopsWhenTheClientDisconnects()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.message","id":"msg_1","content":[{"type":"text","text":"unheard"}]}""", IdleEndTurn]);
        fake.Gate = new TaskCompletionSource();
        using var client = new CancellationTokenSource();
        var events = new List<BaseEvent>();

        await using var run = NewAgent(fake).RunAsync(BaseInput(), client.Token).GetAsyncEnumerator();

        // RUN_STARTED, STATE_SNAPSHOT, and the session CUSTOM event arrive before the turn opens.
        for (var i = 0; i < 3; i++)
        {
            Assert.True(await run.MoveNextAsync());
            events.Add(run.Current);
        }

        // The next event drives the turn: it posts the user message, then waits on the stream.
        var pending = run.MoveNextAsync();
        while (fake.Sent.Count == 0)
        {
            await Task.Delay(5);
        }

        // Disconnect while the turn waits: the run ends with no further events.
        client.Cancel();
        Assert.False(await pending);

        // No error or further events reach the departed client, but the session is interrupted.
        Assert.Equal([AGUIEventTypes.RunStarted, AGUIEventTypes.StateSnapshot, AGUIEventTypes.Custom], Types(events));
        Assert.Contains("user.interrupt", fake.SentTypes);
    }

    [Fact]
    public async Task InterruptsTheSessionAndErrorsWhenTheTurnTimesOut()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        fake.Gate = new TaskCompletionSource(); // never released: the turn stalls

        var events = await CollectAsync(
            NewAgent(fake, configure: options => options.TurnTimeout = TimeSpan.FromMilliseconds(50)),
            BaseInput());

        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal("The turn exceeded the 0.05s limit and was interrupted.", error.Message);
        Assert.Equal("turn_timeout", error.Code);
        Assert.Contains("user.interrupt", fake.SentTypes);
    }

    [Fact]
    public async Task PostsAnInterruptedResultWhenABackendToolIsStillRunningAtTheTimeout()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.custom_tool_use","id":"ctu_1","name":"slow_tool","input":{}}"""]);
        fake.AgentTools = [];
        var released = new TaskCompletionSource<string>();
        var agent = NewAgent(fake, configure: options =>
        {
            options.TurnTimeout = TimeSpan.FromMilliseconds(50);
            options.BackendTools.Add(new ManagedAgentsBackendTool { Name = "slow_tool", Handler = _ => released.Task });
        });

        var events = await CollectAsync(agent, BaseInput());
        released.SetResult("too late");

        // The tool ran past the timeout: its call is answered anyway so the session is not left
        // parked on it, then the turn is interrupted and errors.
        Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Contains(events.OfType<ToolCallStartEvent>(), start => start.ToolCallId == "ctu_1");
        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"Tool execution was interrupted."}],"is_error":true}""",
            Assert.Single(fake.SentEvents, evt => evt.GetProperty("type").GetString() == "user.custom_tool_result"));
        Assert.Contains("user.interrupt", fake.SentTypes);
    }

    [Fact]
    public async Task PostsABackendToolResultEvenWhenTheClientLeavesRightAfterTheHandlerCompletes()
    {
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""", IdleEndTurn]);
        fake.AgentTools = [];
        using var client = new CancellationTokenSource();
        var agent = NewAgent(fake, configure: options =>
            options.BackendTools.Add(new ManagedAgentsBackendTool
            {
                Name = "get_time",
                Handler = _ =>
                {
                    client.Cancel(); // the caller disconnects while the tool finishes
                    return Task.FromResult("noon");
                },
            }));

        await foreach (var _ in agent.RunAsync(BaseInput(), client.Token))
        {
        }

        // The tool already ran, so its result reaches the session despite the disconnect.
        AssertJson(
            """{"type":"user.custom_tool_result","custom_tool_use_id":"ctu_1","content":[{"type":"text","text":"noon"}],"is_error":false}""",
            Assert.Single(fake.SentEvents, evt => evt.GetProperty("type").GetString() == "user.custom_tool_result"));
    }

    private const string Sensitive =
        "401 from https://internal.example/v1/sessions (key sk-ant-SECRET, session sesn_private)";

    [Fact]
    public async Task SurfacesASessionCreateFailureWithoutRelayingItsText()
    {
        // The exception can carry session ids, request paths or credentials, and the client is not
        // necessarily a trusted operator surface: the cause belongs to the hook, the client gets
        // the code.
        var fake = new FakeManagedAgentsClient([IdleEndTurn])
        {
            CreateFailure = new InvalidOperationException(Sensitive),
        };
        var reported = new List<(Exception Error, ManagedAgentsErrorContext Context)>();

        var events = await CollectAsync(
            NewAgent(fake, configure: o => o.OnError = (error, context) => { reported.Add((error, context)); return Task.CompletedTask; }),
            BaseInput());

        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal((ManagedAgentsAgent.RunFailedMessage, "run_failed"), (error.Message, error.Code));
        Assert.DoesNotContain("sk-ant-SECRET", JsonSerializer.Serialize(events));

        var runFailed = Assert.Single(reported, r => r.Context.Operation == "run_failed");
        Assert.Equal(Sensitive, runFailed.Error.Message);
        Assert.Equal("thread_1", runFailed.Context.ThreadId);
    }

    [Fact]
    public async Task DoesNotRelayAFailedDeliverysExceptionTextToTheClient()
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""",
            IdleEndTurn,
        ])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.custom_tool_result")
                ? new InvalidOperationException(Sensitive)
                : null,
        };
        var reported = new List<Exception>();

        var events = await CollectAsync(
            NewAgent(fake, configure: o =>
            {
                o.OnError = (error, _) => { reported.Add(error); return Task.CompletedTask; };
                o.BackendTools.Add(new ManagedAgentsBackendTool
                {
                    Name = "get_time",
                    Handler = _ => Task.FromResult("noon"),
                });
            }),
            BaseInput());

        var error = Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Equal(
            ("The result of tool call ctu_1 could not be delivered to the session.", "tool_result_delivery_failed"),
            (error.Message, error.Code));
        // Not in the RUN_ERROR, and no TOOL_CALL_RESULT was emitted at all.
        Assert.DoesNotContain("sk-ant-SECRET", JsonSerializer.Serialize(events));
        Assert.Empty(events.OfType<ToolCallResultEvent>());
        Assert.Contains(Sensitive, reported.Select(e => e.Message));
    }

    [Fact]
    public async Task ReportsAnInterruptThatCouldNotBePostedViaOnError()
    {
        // A swallowed best-effort failure must still be observable: without OnError the
        // operator sees a wedged thread and nothing in the logs.
        var reported = new List<(Exception Error, ManagedAgentsErrorContext Context)>();
        var fake = new FakeManagedAgentsClient(
            ["""{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""", IdleEndTurn]);
        fake.AgentTools = [];
        fake.SendGuard = batch =>
            batch.Any(e => e.GetProperty("type").GetString() == "user.interrupt")
                ? new InvalidOperationException("interrupt rejected")
                : null;

        using var client = new CancellationTokenSource();
        var agent = NewAgent(fake, configure: options =>
        {
            options.OnError = (error, context) => { reported.Add((error, context)); return Task.CompletedTask; };
            options.BackendTools.Add(new ManagedAgentsBackendTool
            {
                Name = "get_time",
                Handler = _ =>
                {
                    client.Cancel(); // the caller disconnects mid-turn
                    return Task.FromResult("noon");
                },
            });
        });

        try
        {
            await foreach (var _ in agent.RunAsync(BaseInput(), client.Token))
            {
            }
        }
        catch (OperationCanceledException)
        {
            // expected: the caller left
        }

        var interrupt = Assert.Single(reported, r => r.Context.Operation == "interrupt");
        Assert.Equal("interrupt rejected", interrupt.Error.Message);
        Assert.Equal("sesn_1", interrupt.Context.SessionId);
    }

    [Fact]
    public async Task ReportsABackendToolThatFailsAfterTheRunWalkedAway()
    {
        // The handler keeps running after the run stops waiting for it. Its eventual fault was
        // observed only to keep it off the unobserved-exception path — which means a backend tool
        // that failed after a disconnect left no trace at all.
        var reported = new List<string>();
        var handlerFailed = new TaskCompletionSource();
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.custom_tool_use","id":"ctu_1","name":"get_time","input":{}}""",
            IdleEndTurn,
        ]);
        using var client = new CancellationTokenSource();
        var agent = NewAgent(fake, configure: options =>
        {
            options.OnError = (_, context) => { reported.Add(context.Operation); return Task.CompletedTask; };
            options.BackendTools.Add(new ManagedAgentsBackendTool
            {
                Name = "get_time",
                Handler = async _ =>
                {
                    client.Cancel(); // the caller disconnects mid-turn
                    await handlerFailed.Task.ConfigureAwait(false);
                    throw new InvalidOperationException("tool blew up late");
                },
            });
        });

        try
        {
            await foreach (var _ in agent.RunAsync(BaseInput(), client.Token))
            {
            }
        }
        catch (OperationCanceledException)
        {
            // expected: the caller left
        }

        // The handler only fails once the run is gone.
        handlerFailed.SetResult();
        for (var attempt = 0; attempt < 50 && !reported.Contains("abandoned_backend_tool"); attempt++)
        {
            await Task.Delay(10);
        }

        Assert.Contains("abandoned_backend_tool", reported);
    }

    [Fact]
    public async Task ABrokenOnErrorHandlerDoesNotBreakTheRun()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var agent = NewAgent(fake, configure: options =>
            options.OnError = (_, _) => throw new InvalidOperationException("handler is broken"));

        var events = await CollectAsync(agent, BaseInput());

        Assert.Equal(AGUIEventTypes.RunFinished, events[^1].Type);
    }

    [Fact]
    public async Task ReportingAbandonsAHandlerThatNeverCompletes()
    {
        // The shape of an await on a host that blackholes the connection. Callers await this
        // report before emitting the run's terminal event, so without a bound the run never
        // terminates and the thread's run gate is never released — every later run on that
        // thread is refused for the process's lifetime. Without the bound the outer WaitAsync
        // below throws and the test fails.
        var called = false;
        Func<Exception, ManagedAgentsErrorContext, Task> hook = (_, _) =>
        {
            called = true;
            return new TaskCompletionSource().Task; // never completes
        };

        var report = ManagedAgentsErrorReporter.ReportAsync(
            hook,
            "interrupt",
            new InvalidOperationException("boom"),
            sessionId: "sesn_1",
            timeout: TimeSpan.FromMilliseconds(50));

        await report.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(called);
    }

    [Fact]
    public async Task AnAsynchronousOnErrorHandlerIsAwaited()
    {
        // Regression: OnError was an Action, so anyone doing asynchronous telemetry had to write
        // async void — whose exception escapes to the synchronization context and takes the process
        // down, the opposite of "a broken handler cannot break the run". It returns a Task now, so
        // the handler can be awaited and its failure absorbed.
        var reported = new List<string>();
        var fake = new FakeManagedAgentsClient([
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["mystery_1"]}}""",
        ])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.interrupt")
                ? new InvalidOperationException("interrupt rejected")
                : null,
        };

        var events = await CollectAsync(
            NewAgent(fake, configure: o => o.OnError = async (_, context) =>
            {
                await Task.Yield();
                reported.Add(context.Operation);
            }),
            BaseInput());

        // The run reports the real cause, and the awaited handler has already run by the time the
        // run ends — no polling needed.
        Assert.Equal("unsupported_action", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Contains("interrupt", reported);
    }

    [Fact]
    public async Task AnAsynchronousOnErrorHandlerThatFaultsDoesNotBreakTheRun()
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"session.status_idle","id":"idle_1","stop_reason":{"type":"requires_action","event_ids":["mystery_1"]}}""",
        ])
        {
            SendGuard = batch => batch.Any(e => e.GetProperty("type").GetString() == "user.interrupt")
                ? new InvalidOperationException("interrupt rejected")
                : null,
        };

        var events = await CollectAsync(
            NewAgent(fake, configure: o => o.OnError = async (_, _) =>
            {
                await Task.Yield();
                throw new InvalidOperationException("telemetry backend is down");
            }),
            BaseInput());

        Assert.Equal("unsupported_action", Assert.IsType<RunErrorEvent>(events[^1]).Code);
    }

    [Fact]
    public async Task AnOnErrorHandlerReturningNullDoesNotBreakTheRun()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var agent = NewAgent(fake, configure: options => options.OnError = (_, _) => null!);

        var events = await CollectAsync(agent, BaseInput());

        Assert.Equal(AGUIEventTypes.RunFinished, events[^1].Type);
    }

    [Fact]
    public async Task DoesNotRequestPreviewsWhenStreamDeltasIsDisabled()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);

        await CollectAsync(NewAgent(fake, configure: options => options.StreamDeltas = false), BaseInput());

        Assert.Equal([("sesn_1", false)], fake.StreamRequests);
    }

    [Fact]
    public async Task ExtractsTheTextFromMultimodalUserContent()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);

        await CollectAsync(NewAgent(fake), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage
            {
                Id = "u1",
                Content =
                [
                    new AGUITextInputContent { Text = "Look here" },
                    new AGUIImageInputContent { Source = new AGUIInputContentUrlSource { Value = "https://x/y.png" } },
                ],
            },
        ]));

        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"Look here"}]}""", fake.Sent[0].Single());
    }

    [Fact]
    public async Task AbandonsMultiplePendingToolCallsInTheirOriginalOrder()
    {
        var fake = new FakeManagedAgentsClient([IdleEndTurn]);
        var store = new InMemorySessionStore();
        await store.SetAsync(SessionKey, Record(["ctu_1", "ctu_2"]), default);

        await CollectAsync(NewAgent(fake, store), BaseInput(input => input.Messages =
        [
            new AGUIUserMessage { Id = "u1", Content = "old" },
            new AGUIUserMessage { Id = "u2", Content = "never mind" },
        ]));

        // Both abandoned results are batched before the user message, in the order they were parked.
        var abandoned = fake.Sent[0];
        Assert.Equal(
            ["ctu_1", "ctu_2"],
            abandoned.Select(evt => evt.GetProperty("custom_tool_use_id").GetString()));
        Assert.All(abandoned, evt => Assert.True(evt.GetProperty("is_error").GetBoolean()));
        AssertJson("""{"type":"user.message","content":[{"type":"text","text":"never mind"}]}""", fake.Sent[1].Single());
    }
}
