using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// An AG-UI agent backed by Claude Managed Agents. Each AG-UI thread maps to one managed
/// session; each run drives one turn of that session and streams its events as AG-UI events.
/// </summary>
public sealed class ManagedAgentsAgent
{
    /// <summary>
    /// The <c>CUSTOM</c> event name emitted with the new session ID when a session is created.
    /// </summary>
    public const string SessionCustomEventName = "managed_agents.session";

    private const string AbandonedToolResult = "The user did not provide a result for this tool call.";

    /// <summary>
    /// The fingerprint stored for a session created without custom tools, i.e. one that runs the
    /// managed agent as-is with no override list.
    /// </summary>
    private static readonly string s_noOverridesFingerprint = ManagedAgentsCustomTools.FingerprintOf([]);

    /// <summary>
    /// The only thing a client is told about a failure this integration did not author. An SDK,
    /// session-store or API exception can carry session ids, request paths, backend hostnames or
    /// credentials, and the AG-UI client is not necessarily a trusted operator surface — so the
    /// cause goes to <see cref="ManagedAgentsAgentOptions.OnError"/> and the client gets this plus
    /// the machine-readable code.
    /// </summary>
    internal const string RunFailedMessage = "The run failed.";

    private readonly ManagedAgentsAgentOptions _options;
    private readonly IManagedAgentsClient _client;
    private readonly ISessionStore _store;
    private readonly IReadOnlyDictionary<string, ManagedAgentsBackendTool> _backendTools;

    // A thread runs one turn at a time. Keys are scoped to this managed agent so distinct
    // agents never collide.
    // Keyed by session-store identity: the store is the unit of tenancy, so agents
    // sharing a store serialize runs per thread (even across instances), while
    // per-caller stores keep one caller's runs from blocking another's.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<ISessionStore, ConcurrentDictionary<string, byte>> s_busyThreadsByStore = new();

    /// <summary>
    /// The keys currently held by the busy-run gate for <paramref name="store"/>, or
    /// <see langword="null"/> if it has none. Exists so tests can assert that the gate and the
    /// session store agree on the key; the TypeScript and Python ports reach their equivalents
    /// directly.
    /// </summary>
    internal static IReadOnlyCollection<string>? BusyKeysFor(ISessionStore store)
        => s_busyThreadsByStore.TryGetValue(store, out var busy) ? [.. busy.Keys] : null;

    /// <summary>
    /// Initializes a new instance of the <see cref="ManagedAgentsAgent"/> class.
    /// </summary>
    /// <param name="options">The agent configuration.</param>
    public ManagedAgentsAgent(ManagedAgentsAgentOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (string.IsNullOrEmpty(options.ManagedAgentId))
        {
            throw new ArgumentException("ManagedAgentId is required.", nameof(options));
        }

        if (string.IsNullOrEmpty(options.EnvironmentId))
        {
            throw new ArgumentException("EnvironmentId is required.", nameof(options));
        }

        _options = options;
        _client = options.Client ?? new AnthropicManagedAgentsClient(options.AnthropicClient ?? new Anthropic.AnthropicClient());
        _store = options.SessionStore ?? new InMemorySessionStore();

        // Normalized names may collide (e.g. "search.web" and "search_web"); last write wins,
        // matching the frontend-tool map.
        var backendTools = new Dictionary<string, ManagedAgentsBackendTool>(StringComparer.Ordinal);
        foreach (var tool in options.BackendTools)
        {
            backendTools[ManagedAgentsCustomTools.NormalizeToolName(tool.Name)] = tool;
        }

        _backendTools = backendTools;
    }

    /// <summary>
    /// Runs one turn for the input's thread and streams the resulting AG-UI events. Thread↔session
    /// state is keyed by <c>managedAgentId:threadId</c> (see <see cref="ISessionStore"/>); supply a
    /// session store that partitions by caller if you need multi-tenant isolation.
    /// </summary>
    /// <param name="input">The AG-UI run input.</param>
    /// <param name="cancellationToken">A token that aborts the run, for example when the client disconnects.</param>
    /// <returns>The AG-UI event stream for the run.</returns>
    public async IAsyncEnumerable<BaseEvent> RunAsync(
        RunAgentInput input,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(input);

        // A run emits exactly one terminal event. Something failing after the turn already
        // reported an outcome — a session store that rejects the closing write, say — must not
        // append a second RUN_ERROR behind a RUN_ERROR or a RUN_FINISHED. The dropped error still
        // reaches the error hook so it is not lost.
        var terminated = false;
        await foreach (var evt in StreamRunAsync(input, cancellationToken).ConfigureAwait(false))
        {
            if (evt is RunErrorEvent or RunFinishedEvent)
            {
                if (terminated)
                {
                    if (evt is RunErrorEvent dropped)
                    {
                        await ReportAsync(
                            "dropped_terminal_event",
                            new InvalidOperationException(dropped.Message),
                            threadId: input.ThreadId).ConfigureAwait(false);
                    }

                    continue;
                }

                terminated = true;
            }

            yield return evt;
        }
    }

    private async IAsyncEnumerable<BaseEvent> StreamRunAsync(
        RunAgentInput input,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var threadId = input.ThreadId;
        var runId = input.RunId;
        yield return new RunStartedEvent { ThreadId = threadId, RunId = runId };
        if (input.State is JsonElement state && state.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
        {
            yield return new StateSnapshotEvent { Snapshot = state };
        }

        // A blank thread id is not a thread: every caller that omitted one would share a single
        // key, and so a single managed session and its history.
        if (string.IsNullOrWhiteSpace(threadId))
        {
            yield return new RunErrorEvent
            {
                Message = "This run has no thread id. Every run must carry a non-empty threadId.",
                Code = "invalid_thread_id",
            };
            yield break;
        }

        // One key for the session store and the busy-run gate, so a stored session and the gate
        // that serializes access to it can never disagree.
        var threadKey = SessionKey(threadId);
        var busyThreads = s_busyThreadsByStore.GetOrCreateValue(_store);
        if (!busyThreads.TryAdd(threadKey, 0))
        {
            yield return new RunErrorEvent { Message = "A run is already in progress on this thread.", Code = "run_in_progress" };
            yield break;
        }

        // The gate is held only inside this try, so it is released however the run ends.
        try
        {
            // A deserialized input may carry a null message list; treat it as empty. Check for
            // something sendable before touching the API, so a malformed run does not create an
            // orphan session.
            var messages = input.Messages ?? [];
            if (!HasSendableContent(messages))
            {
                yield return new RunErrorEvent
                {
                    Message = "There is nothing to send: this run has no user message or tool result.",
                    Code = "empty_run",
                };
                yield break;
            }

            var run = new RunContext();
            using var timeout = new CancellationTokenSource(_options.TurnTimeout);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
            var events = RunCoreAsync(input, messages, threadKey, run, linked.Token).GetAsyncEnumerator(CancellationToken.None);
            await using var eventsScope = events.ConfigureAwait(false);
            BaseEvent? errorEvent = null;
            while (true)
            {
                BaseEvent current;
                try
                {
                    if (!await events.MoveNextAsync().ConfigureAwait(false))
                    {
                        break;
                    }

                    current = events.Current;
                }
                catch (OperationCanceledException) when (linked.IsCancellationRequested)
                {
                    // Interrupt the session so it does not keep working on a turn nobody hears.
                    // A cancelled turn never reaches RecordOutcomeAsync, so reconcile here: the
                    // landed interrupt cancelled the wait, and a park recorded during this turn
                    // would otherwise be answered against a call that no longer exists.
                    if (await InterruptAsync(run.SessionId).ConfigureAwait(false))
                    {
                        await ForgetParkedCallsAsync(run).ConfigureAwait(false);
                    }
                    if (cancellationToken.IsCancellationRequested)
                    {
                        // The client went away; there is nobody left to tell.
                        yield break;
                    }

                    errorEvent = new RunErrorEvent
                    {
                        Message = $"The turn exceeded the {FormatSeconds(_options.TurnTimeout)} limit and was interrupted.",
                        Code = "turn_timeout",
                    };
                    break;
                }
                catch (Exception ex)
                {
                    // Detail to the hook, not to the client: see RunFailedMessage.
                    await ReportAsync("run_failed", ex, run.SessionId, threadId).ConfigureAwait(false);
                    errorEvent = new RunErrorEvent { Message = RunFailedMessage, Code = "run_failed" };
                    break;
                }

                yield return current;
            }

            if (errorEvent is not null)
            {
                // Close any block the failed turn left open before reporting the error.
                if (run.Turn is not null)
                {
                    foreach (var evt in run.Turn.CloseOpenBlocks())
                    {
                        yield return evt;
                    }
                }

                yield return errorEvent;
            }
        }
        finally
        {
            busyThreads.TryRemove(threadKey, out _);
        }
    }

    private async IAsyncEnumerable<BaseEvent> RunCoreAsync(
        RunAgentInput input,
        IList<AGUIMessage> messages,
        string threadKey,
        RunContext run,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var record = await _store.GetAsync(threadKey, cancellationToken).ConfigureAwait(false);
        if (record is null)
        {
            // A tool result only answers a pending call, so it cannot start a thread: creating
            // a session for it would orphan the session.
            if (!HasUserText(messages))
            {
                yield return new RunErrorEvent
                {
                    Message = "There is nothing to send: a tool result arrived for a thread with no session.",
                    Code = "tool_result_without_session",
                };
                yield break;
            }

            // The busy-thread gate serializes runs per thread, so creation cannot race.
            record = await CreateSessionAsync(input, cancellationToken).ConfigureAwait(false);
            await _store.SetAsync(threadKey, record, cancellationToken).ConfigureAwait(false);
            yield return new CustomEvent
            {
                Name = SessionCustomEventName,
                Value = JsonSerializer.SerializeToElement(new SessionEventValue(record.SessionId, input.ThreadId)),
            };
        }

        run.SessionId = record.SessionId;
        run.Record = record;
        run.ThreadKey = threadKey;
        await SyncClientToolsAsync(record, input.Tools, cancellationToken).ConfigureAwait(false);

        var outbound = OutboundEvents(record, messages);
        if (outbound.Events.Count == 0)
        {
            yield return new RunErrorEvent
            {
                Message = "There is nothing new to send: no user message or tool result in this run.",
                Code = "nothing_to_send",
            };
            yield break;
        }

        // Some parked tool calls are still unanswered: post what we have and stay parked
        // instead of waiting on a session that will not resume.
        if (outbound.StillParked.Count > 0)
        {
            await _client.SendEventsAsync(record.SessionId, outbound.Events, cancellationToken).ConfigureAwait(false);
            record.PendingClientToolUseIds = outbound.StillParked;
            record.LastUserMessageId = outbound.LastUserMessageId ?? record.LastUserMessageId;
            await PersistDeliveredAsync(threadKey, record).ConfigureAwait(false);
            yield return new RunFinishedEvent { ThreadId = input.ThreadId, RunId = input.RunId };
            yield break;
        }

        // Normalized names may collide (e.g. "search.web" and "search_web");
        // last write wins rather than throwing on a duplicate key.
        var clientTools = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var tool in input.Tools ?? [])
        {
            clientTools[ManagedAgentsCustomTools.NormalizeToolName(tool.Name)] = tool.Name;
        }

        var turn = new ManagedAgentsTurn(
            _client,
            record.SessionId,
            outbound.Events,
            clientTools,
            _backendTools,
            _options.ToolConfirmation,
            _options.StreamDeltas,
            // Persist each delivery as soon as it lands, so a failure or interruption later in
            // the turn does not re-post it next run: the tool results resume the session even
            // if the follow-ups then fail.
            onResultsSent: () =>
            {
                record.PendingClientToolUseIds = [];
                return PersistDeliveredAsync(threadKey, record);
            },
            onFollowUpsSent: () =>
            {
                if (outbound.LastUserMessageId is not null)
                {
                    record.LastUserMessageId = outbound.LastUserMessageId;
                }

                return PersistDeliveredAsync(threadKey, record);
            },
            // Persist a park the moment the call is handed to the UI. A later event can fail the
            // turn before the session confirms the park, and the remote session would then wait
            // on an id nothing remembers.
            onClientPark: toolUseId =>
            {
                if (record.PendingClientToolUseIds.Contains(toolUseId))
                {
                    return Task.CompletedTask;
                }

                record.PendingClientToolUseIds = [.. record.PendingClientToolUseIds, toolUseId];
                return PersistDeliveredAsync(threadKey, record);
            },
            onError: _options.OnError);
        run.Turn = turn;

        await foreach (var evt in turn.RunAsync(cancellationToken).ConfigureAwait(false))
        {
            yield return evt;
        }

        var outcome = turn.Outcome;
        await RecordOutcomeAsync(threadKey, record, outcome).ConfigureAwait(false);
        if (outcome.Status != ManagedAgentsTurnStatus.Errored)
        {
            yield return new RunFinishedEvent { ThreadId = input.ThreadId, RunId = input.RunId };
        }
    }

    /// <summary>
    /// Records the turn's outcome once the turn has ended. Non-cancellable: what happened in
    /// the session has already happened, so the record must reflect it even if the client left.
    /// An errored turn keeps whatever the park callback already persisted: the remote session is
    /// still parked on those calls and the next run has to answer them.
    /// </summary>
    private async Task RecordOutcomeAsync(string threadKey, ManagedAgentsSessionRecord record, ManagedAgentsTurnOutcome outcome)
    {
        if (outcome.Status == ManagedAgentsTurnStatus.Errored)
        {
            if (outcome.SessionEnded)
            {
                await _store.DeleteAsync(threadKey, CancellationToken.None).ConfigureAwait(false);
            }
            else if (outcome.SessionInterrupted && record.PendingClientToolUseIds.Count > 0)
            {
                // An interrupt that landed cancelled whatever the session was waiting on, so a
                // park recorded during this turn is no longer answerable: posting a result for it
                // next run is rejected as stale and wedges the thread.
                record.PendingClientToolUseIds = [];
                await PersistDeliveredAsync(threadKey, record).ConfigureAwait(false);
            }

            return;
        }

        if (outcome.Status == ManagedAgentsTurnStatus.Parked)
        {
            record.PendingClientToolUseIds = [.. outcome.ClientToolUseIds];
            await PersistDeliveredAsync(threadKey, record).ConfigureAwait(false);
            return;
        }

        // The session went idle on end_turn: nothing is awaited any more.
        if (record.PendingClientToolUseIds.Count > 0)
        {
            record.PendingClientToolUseIds = [];
            await PersistDeliveredAsync(threadKey, record).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The key that identifies a thread's state, in the session store and the busy-run gate alike,
    /// so two agents sharing one store neither adopt each other's sessions nor serialize against
    /// each other's threads.
    /// </summary>
    /// <remarks>
    /// Every field baked into the remote session at creation is part of the key: none of them can
    /// be re-checked or changed on resume, so an agent must never inherit a session created with a
    /// different environment, pinned version or vault set. Each is length-prefixed so no two
    /// combinations can collide — plain concatenation would let a <c>ManagedAgentId</c> of
    /// <c>support:beta</c> with thread <c>t1</c> and one of <c>support</c> with thread
    /// <c>beta:t1</c> share one record. The thread id is last, so it needs no prefix and may
    /// contain anything.
    /// </remarks>
    private string SessionKey(string threadId)
    {
        static string Field(string value) => $"{value.Length}:{value}|";

        // Sorted: the same vaults in a different order are the same session.
        var vaults = _options.VaultIds.OrderBy(id => id, StringComparer.Ordinal);
        return Field(_options.ManagedAgentId)
            + Field(_options.AgentVersion?.ToString(CultureInfo.InvariantCulture) ?? string.Empty)
            + Field(_options.EnvironmentId)
            + Field(string.Join(",", vaults))
            + threadId;
    }

    /// <summary>
    /// Drops the parked tool calls recorded for this thread, because the session was interrupted
    /// and will never answer them. Best-effort: the run is already ending, and a store that
    /// refuses the write must not replace the error that got us here.
    /// </summary>
    private async Task ForgetParkedCallsAsync(RunContext run)
    {
        if (run.Record is not { } record || run.ThreadKey is not { } threadKey)
        {
            return;
        }

        if (record.PendingClientToolUseIds.Count == 0)
        {
            return;
        }

        record.PendingClientToolUseIds = [];
        try
        {
            await PersistDeliveredAsync(threadKey, record).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await ReportAsync("forget_parked_calls", ex, run.SessionId).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Stores the record after its events were delivered to the session. Non-cancellable: a
    /// skipped write would make the next run re-post the same message and stale tool results.
    /// </summary>
    private Task PersistDeliveredAsync(string threadKey, ManagedAgentsSessionRecord record)
    {
        return _store.SetAsync(threadKey, record, CancellationToken.None).AsTask();
    }

    /// <summary>
    /// Works out what to post into the session for this run: results for any tool calls the
    /// frontend was asked to run, plus every user message not yet delivered (in order).
    /// </summary>
    private static OutboundEventSet OutboundEvents(ManagedAgentsSessionRecord record, IList<AGUIMessage> messages)
    {
        var events = new List<JsonElement>();
        var pending = new List<string>(record.PendingClientToolUseIds);

        foreach (var message in messages)
        {
            if (message is not AGUIToolMessage toolMessage || !pending.Remove(toolMessage.ToolCallId))
            {
                continue;
            }

            events.Add(ManagedAgentsSessionEvents.CustomToolResult(
                toolMessage.ToolCallId,
                ToolResultText(toolMessage),
                isError: !string.IsNullOrEmpty(toolMessage.Error)));
        }

        // User messages after the last delivered one; on first contact, just the newest.
        string? lastUserMessageId = null;
        var userMessages = messages.OfType<AGUIUserMessage>().ToList();
        var deliveredIndex = record.LastUserMessageId is null
            ? -1
            : userMessages.FindIndex(message => string.Equals(message.Id, record.LastUserMessageId, StringComparison.Ordinal));
        var undelivered = deliveredIndex >= 0
            ? userMessages.Skip(deliveredIndex + 1)
            : userMessages.Skip(Math.Max(0, userMessages.Count - 1));
        foreach (var message in undelivered)
        {
            var text = UserTextOf(message).Trim();
            if (text.Length == 0)
            {
                continue;
            }

            events.Add(ManagedAgentsSessionEvents.UserMessage(text));
            lastUserMessageId = message.Id;
        }

        // The user moved on without answering the tools the frontend was asked to run: fail
        // those calls (in the order they were parked) so the agent can respond to the new
        // message. The results go first, then the user message.
        if (lastUserMessageId is not null && pending.Count > 0)
        {
            events.InsertRange(0, pending.Select(static toolUseId =>
                ManagedAgentsSessionEvents.CustomToolResult(toolUseId, AbandonedToolResult, isError: true)));
            pending.Clear();
        }

        return new OutboundEventSet(events, pending, lastUserMessageId);
    }

    private async Task<ManagedAgentsSessionRecord> CreateSessionAsync(RunAgentInput input, CancellationToken cancellationToken)
    {
        var customTools = CustomToolsFor(input.Tools);
        var request = new ManagedAgentSessionRequest
        {
            ManagedAgentId = _options.ManagedAgentId,
            AgentVersion = _options.AgentVersion,
            EnvironmentId = _options.EnvironmentId,
            Title = _options.SessionTitle?.Invoke(input.ThreadId) ?? $"AG-UI thread {input.ThreadId}",
            VaultIds = _options.VaultIds.Count > 0 ? [.. _options.VaultIds] : null,
        };

        // An empty custom list means no overrides at all: the session runs the agent as-is, so
        // Console edits to its tools apply without an update from here.
        List<JsonElement> registered = [];
        if (customTools.Count > 0)
        {
            // Overrides replace the tool list, so keep the agent's own tools.
            registered = await MergedToolsAsync(customTools, cancellationToken).ConfigureAwait(false);
            request.OverrideTools = registered;
        }

        var sessionId = await _client.CreateSessionAsync(request, cancellationToken).ConfigureAwait(false);
        return new ManagedAgentsSessionRecord
        {
            SessionId = sessionId,
            ToolNames = customTools.Keys.ToList(),
            ToolDefinitionsFingerprint = ManagedAgentsCustomTools.FingerprintOf(registered),
            PendingClientToolUseIds = [],
        };
    }

    /// <summary>
    /// Frontend tools plus configured backend tools, as custom tool definitions keyed by
    /// normalized name in registration order. On a collision the frontend tool wins, matching
    /// dispatch order in the turn loop.
    /// </summary>
    private OrderedToolMap CustomToolsFor(IList<AGUITool>? clientTools)
    {
        var tools = new OrderedToolMap();
        foreach (var tool in _options.BackendTools)
        {
            tools.Set(ManagedAgentsCustomTools.NormalizeToolName(tool.Name), ManagedAgentsCustomTools.CustomToolFrom(tool.Name, tool.Description, tool.Parameters));
        }

        foreach (var tool in clientTools ?? [])
        {
            // Parameters is optional on the protocol's Tool, and a tool that
            // declares none is a tool that takes none: an undefined element is
            // not an object, which InputSchemaFrom already reads as the empty
            // object schema.
            var custom = ManagedAgentsCustomTools.CustomToolFrom(
                tool.Name, tool.Description, tool.Parameters ?? default);
            tools.Set(ManagedAgentsCustomTools.NameOf(custom) ?? ManagedAgentsCustomTools.NormalizeToolName(tool.Name), custom);
        }

        return tools;
    }

    /// <summary>Keeps the session's full replacement tool list aligned with this run.</summary>
    /// <remarks>
    /// The fingerprint covers the merged list, not just the custom tools: an override session's
    /// list is a full replacement frozen at the last update, so editing the agent's own tools in
    /// the Console changes what the session should hold while every custom tool stays identical.
    /// Comparing custom tools alone declared that a match and left the session on a stale list
    /// indefinitely.
    /// <para>
    /// The cost is re-reading the agent's tools once per run for a session that uses overrides. A
    /// session with no custom tools runs the agent as-is, needs no update, and is short-circuited
    /// before that read.
    /// </para>
    /// </remarks>
    private async Task SyncClientToolsAsync(ManagedAgentsSessionRecord record, IList<AGUITool>? clientTools, CancellationToken cancellationToken)
    {
        var desired = CustomToolsFor(clientTools);
        // A session created without custom tools has no override list to keep in step, and Console
        // edits to the agent reach it on their own.
        if (desired.Count == 0
            && string.Equals(record.ToolDefinitionsFingerprint, s_noOverridesFingerprint, StringComparison.Ordinal))
        {
            return;
        }

        // Note this still merges when `desired` is empty but the session does have an override
        // list: it must be replaced with the agent's own tools, not emptied.
        var registered = await MergedToolsAsync(desired, cancellationToken).ConfigureAwait(false);
        var fingerprint = ManagedAgentsCustomTools.FingerprintOf(registered);
        if (string.Equals(record.ToolDefinitionsFingerprint, fingerprint, StringComparison.Ordinal))
        {
            return;
        }

        await _client.UpdateSessionToolsAsync(record.SessionId, registered, cancellationToken).ConfigureAwait(false);
        record.ToolNames = desired.Keys.ToList();
        record.ToolDefinitionsFingerprint = fingerprint;
    }

    /// <summary>
    /// The agent's own tools plus custom tools, without duplicate names. Overrides replace the
    /// whole list, so the agent's tools are carried along, but a custom tool of the same name
    /// wins over the agent's copy.
    /// </summary>
    private async Task<List<JsonElement>> MergedToolsAsync(OrderedToolMap customTools, CancellationToken cancellationToken)
    {
        var names = new HashSet<string>(customTools.Keys, StringComparer.Ordinal);
        var baseTools = await BaseToolsAsync(cancellationToken).ConfigureAwait(false);
        return baseTools
            .Where(tool => !(tool.TryGetProperty("type", out var type)
                && type.ValueEquals("custom")
                && tool.TryGetProperty("name", out var name)
                && name.ValueKind == JsonValueKind.String
                && names.Contains(name.GetString()!)))
            .Concat(customTools.Values)
            .ToList();
    }

    /// <summary>
    /// The tools defined on the managed agent itself, fetched fresh so console edits apply.
    /// </summary>
    private Task<IReadOnlyList<JsonElement>> BaseToolsAsync(CancellationToken cancellationToken)
    {
        return _client.GetAgentToolsAsync(_options.ManagedAgentId, _options.AgentVersion, cancellationToken);
    }

    /// <summary>
    /// Reports a swallowed failure. A broken handler must never break the run, and an asynchronous
    /// one is awaited so its telemetry is not left racing the end of the run. See
    /// <see cref="ManagedAgentsErrorReporter"/>.
    /// </summary>
    private Task ReportAsync(string operation, Exception error, string? sessionId = null, string? threadId = null)
    {
        return ManagedAgentsErrorReporter.ReportAsync(_options.OnError, operation, error, sessionId, threadId);
    }

    /// <summary>Stops the session best-effort, reporting whether it landed.</summary>
    private async Task<bool> InterruptAsync(string? sessionId)
    {
        if (sessionId is null)
        {
            return false;
        }

        try
        {
            // Bounded: this runs while the busy gate is still held, so a stalled
            // send must not block the thread's later runs.
            using var sendTimeout = new CancellationTokenSource(ManagedAgentsLimits.BestEffortSendTimeout);
            await _client
                .SendEventsAsync(sessionId, [ManagedAgentsSessionEvents.Interrupt()], sendTimeout.Token)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Best effort (including the send's own timeout): the run is already ending.
            await ReportAsync("interrupt", ex, sessionId).ConfigureAwait(false);
            return false;
        }

        return true;
    }

    /// <summary>A tool message's payload: its content plus any error text, matching the other ports.</summary>
    private static string ToolResultText(AGUIToolMessage message)
    {
        return string.Join("\n", new[] { message.Content, message.Error }.Where(static part => !string.IsNullOrEmpty(part)));
    }

    /// <summary>Formats a timeout for the RUN_ERROR message without rounding sub-second values to "0s".</summary>
    private static string FormatSeconds(TimeSpan timeout)
    {
        return $"{timeout.TotalSeconds.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)}s";
    }

    /// <summary>
    /// Whether the run carries a user message with text or a tool result.
    /// </summary>
    private static bool HasSendableContent(IList<AGUIMessage> messages)
    {
        return messages.Any(static message => message is AGUIToolMessage) || HasUserText(messages);
    }

    /// <summary>
    /// Whether the run carries a user message with text, the only thing that can start a thread.
    /// </summary>
    private static bool HasUserText(IList<AGUIMessage> messages)
    {
        return messages.Any(static message => message is AGUIUserMessage user && UserTextOf(user).Trim().Length > 0);
    }

    private static string UserTextOf(AGUIUserMessage message)
    {
        return string.Concat(message.Content.OfType<AGUITextInputContent>().Select(static part => part.Text));
    }

    private sealed class RunContext
    {
        internal string? SessionId { get; set; }

        internal ManagedAgentsTurn? Turn { get; set; }

        /// <summary>This thread's record, so teardown can reconcile it after an interrupt.</summary>
        internal ManagedAgentsSessionRecord? Record { get; set; }

        internal string? ThreadKey { get; set; }
    }

    private sealed class OutboundEventSet
    {
        internal OutboundEventSet(List<JsonElement> events, List<string> stillParked, string? lastUserMessageId)
        {
            Events = events;
            StillParked = stillParked;
            LastUserMessageId = lastUserMessageId;
        }

        internal List<JsonElement> Events { get; }

        internal List<string> StillParked { get; }

        internal string? LastUserMessageId { get; }
    }

    private sealed class SessionEventValue
    {
        internal SessionEventValue(string sessionId, string threadId)
        {
            SessionId = sessionId;
            ThreadId = threadId;
        }

        [System.Text.Json.Serialization.JsonPropertyName("sessionId")]
        public string SessionId { get; }

        [System.Text.Json.Serialization.JsonPropertyName("threadId")]
        public string ThreadId { get; }
    }

    /// <summary>
    /// A name → tool map that preserves first-registration order while letting a later
    /// registration replace the definition.
    /// </summary>
    private sealed class OrderedToolMap
    {
        private readonly List<string> _order = [];
        private readonly Dictionary<string, JsonElement> _tools = new(StringComparer.Ordinal);

        internal void Set(string name, JsonElement tool)
        {
            if (!_tools.ContainsKey(name))
            {
                _order.Add(name);
            }

            _tools[name] = tool;
        }

        internal int Count => _order.Count;

        internal IEnumerable<string> Keys => _order;

        internal IEnumerable<JsonElement> Values => _order.Select(name => _tools[name]);
    }
}
