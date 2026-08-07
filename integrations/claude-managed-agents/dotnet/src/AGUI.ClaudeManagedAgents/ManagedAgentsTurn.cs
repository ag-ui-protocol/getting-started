using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using AGUI.Abstractions;
using Anthropic.Models.Beta.Sessions;
using Anthropic.Models.Beta.Sessions.Events;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Drives one turn of a managed session: opens the event stream, posts the outbound events,
/// and translates the session's events into AG-UI events until the session goes idle.
/// </summary>
/// <remarks>
/// Invariant: no <c>TEXT_MESSAGE</c> or <c>REASONING</c> block is left open when a turn
/// finishes or errors. Every exit path closes them, and <see cref="CloseOpenBlocks"/> lets the
/// caller close whatever is still open when the turn throws.
/// </remarks>
internal sealed class ManagedAgentsTurn
{
    private const string InterruptedToolResult = "Tool execution was interrupted.";

    private readonly IManagedAgentsClient _client;
    private readonly string _sessionId;
    private readonly IReadOnlyList<JsonElement> _outbound;
    private readonly IReadOnlyDictionary<string, string> _clientTools;
    private readonly IReadOnlyDictionary<string, ManagedAgentsBackendTool> _backendTools;
    private readonly string? _toolConfirmation;
    private readonly bool _streamDeltas;
    private readonly Func<Task>? _onResultsSent;
    private readonly Func<Task>? _onFollowUpsSent;
    private readonly Func<string, Task>? _onClientPark;
    private readonly Func<Exception, ManagedAgentsErrorContext, Task>? _onError;

    private readonly Queue<BaseEvent> _pending = new();
    private readonly Dictionary<string, StringBuilder> _previews = new(StringComparer.Ordinal);
    private readonly HashSet<string> _closedMessages = new(StringComparer.Ordinal);
    private readonly HashSet<string> _openReasoning = new(StringComparer.Ordinal);
    private readonly List<string> _openReasoningOrder = new();
    private readonly HashSet<string> _ackedToolUses = new(StringComparer.Ordinal);
    private readonly HashSet<string> _clientParks = new(StringComparer.Ordinal);
    private readonly HashSet<string> _askedConfirmations = new(StringComparer.Ordinal);
    private bool _done;

    /// <summary>
    /// Initializes a new instance of the <see cref="ManagedAgentsTurn"/> class.
    /// </summary>
    /// <param name="client">The Managed Agents client.</param>
    /// <param name="sessionId">The session to drive.</param>
    /// <param name="outbound">Events posted into the session once the stream is open.</param>
    /// <param name="clientTools">Frontend tools, keyed by managed-agent (normalized) name to the original AG-UI name. Calls to these park the session.</param>
    /// <param name="backendTools">Custom tools executed on this server, keyed by managed-agent (normalized) name.</param>
    /// <param name="toolConfirmation">How to answer built-in tools gated on confirmation, or <see langword="null"/> to fail the run.</param>
    /// <param name="streamDeltas">Whether to request text and thinking previews.</param>
    /// <param name="onResultsSent">
    /// Called once the tool-result batch has been posted into the session. Fires separately from
    /// <paramref name="onFollowUpsSent"/> so the caller persists each delivery independently: the
    /// results resume the session even if the follow-ups then fail, and re-posting them on the
    /// next run would be rejected as stale.
    /// </param>
    /// <param name="onFollowUpsSent">Called once the follow-up messages have been posted into the session.</param>
    /// <param name="onClientPark">
    /// Called as soon as a frontend tool call is handed to the UI unanswered, so the caller can
    /// record that the remote session is about to park on it. The turn can still fail (or be torn
    /// down) before the session confirms the park, and the ID has to survive that: nothing else
    /// can tell the next run which call the remote session is waiting on.
    /// </param>
    /// <param name="onError">Notified when a best-effort operation fails. Never throws into the turn.</param>
    internal ManagedAgentsTurn(
        IManagedAgentsClient client,
        string sessionId,
        IReadOnlyList<JsonElement> outbound,
        IReadOnlyDictionary<string, string> clientTools,
        IReadOnlyDictionary<string, ManagedAgentsBackendTool> backendTools,
        string? toolConfirmation,
        bool streamDeltas,
        Func<Task>? onResultsSent = null,
        Func<Task>? onFollowUpsSent = null,
        Func<string, Task>? onClientPark = null,
        Func<Exception, ManagedAgentsErrorContext, Task>? onError = null)
    {
        _client = client;
        _sessionId = sessionId;
        _outbound = outbound;
        _clientTools = clientTools;
        _backendTools = backendTools;
        _toolConfirmation = toolConfirmation;
        _streamDeltas = streamDeltas;
        _onResultsSent = onResultsSent;
        _onFollowUpsSent = onFollowUpsSent;
        _onClientPark = onClientPark;
        _onError = onError;
    }

    /// <summary>
    /// Reports a swallowed failure. A broken handler must never break the turn, and an asynchronous
    /// one is awaited so its telemetry is not left racing the end of the turn. See
    /// <see cref="ManagedAgentsErrorReporter"/>.
    /// </summary>
    private Task ReportAsync(string operation, Exception error)
    {
        return ManagedAgentsErrorReporter.ReportAsync(_onError, operation, error, _sessionId);
    }

    /// <summary>
    /// <see cref="ReportAsync"/> from a callback that cannot await, such as a task continuation.
    /// </summary>
    private void ReportDetached(string operation, Exception error)
    {
        ManagedAgentsErrorReporter.ReportDetached(_onError, operation, error, _sessionId);
    }

    /// <summary>
    /// The outcome of the turn. Valid once <see cref="RunAsync"/> completes; a turn that
    /// throws leaves the default errored outcome.
    /// </summary>
    internal ManagedAgentsTurnOutcome Outcome { get; private set; } = ManagedAgentsTurnOutcome.Errored;

    /// <summary>
    /// Runs the turn, yielding the translated AG-UI events.
    /// </summary>
    internal async IAsyncEnumerable<BaseEvent> RunAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // Open the stream before sending so no early events are missed.
        var stream = await _client.OpenEventStreamAsync(_sessionId, _streamDeltas, cancellationToken).ConfigureAwait(false);
        await using (((IAsyncDisposable)stream).ConfigureAwait(false))
        {
            await SendOutboundAsync(cancellationToken).ConfigureAwait(false);

            await foreach (var streamEvent in stream.WithCancellation(cancellationToken).ConfigureAwait(false))
            {
                await HandleAsync(streamEvent, cancellationToken).ConfigureAwait(false);
                foreach (var evt in Drain())
                {
                    yield return evt;
                }

                if (_done)
                {
                    yield break;
                }
            }
        }

        // The stream ended without a terminal event.
        CloseAll();
        foreach (var evt in Drain())
        {
            yield return evt;
        }

        cancellationToken.ThrowIfCancellationRequested();
        Fail("The session event stream ended before the reply completed.", "stream_ended");
        foreach (var evt in Drain())
        {
            yield return evt;
        }
    }

    /// <summary>
    /// Posts the outbound events. A parked session accepts only tool results, so those go
    /// first (which resumes it) and any user messages follow in a second call: the API
    /// validates a whole batch against the session's current state, so mixing them fails.
    /// Each delivery is reported to its own callback as soon as it lands.
    /// </summary>
    private async Task SendOutboundAsync(CancellationToken cancellationToken)
    {
        var followUps = _outbound.Where(IsFollowUp).ToList();
        var results = _outbound.Where(static evt => !IsFollowUp(evt)).ToList();

        if (results.Count > 0)
        {
            await _client.SendEventsAsync(_sessionId, results, cancellationToken).ConfigureAwait(false);
            if (_onResultsSent is not null)
            {
                await _onResultsSent().ConfigureAwait(false);
            }
        }

        if (followUps.Count > 0)
        {
            await SendFollowUpsAsync(followUps, cancellationToken).ConfigureAwait(false);
            if (_onFollowUpsSent is not null)
            {
                await _onFollowUpsSent().ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// The session un-parks asynchronously after a tool result is posted, so a follow-up user
    /// message can race ahead of that transition and be rejected as sent-while-parked. Retries
    /// briefly on that specific error only.
    /// </summary>
    private async Task SendFollowUpsAsync(IReadOnlyList<JsonElement> followUps, CancellationToken cancellationToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await _client.SendEventsAsync(_sessionId, followUps, cancellationToken).ConfigureAwait(false);
                return;
            }
            catch (Exception ex) when (attempt < ManagedAgentsLimits.SentWhileParkedRetryDelays.Length && IsSentWhileParked(ex))
            {
                await Task.Delay(ManagedAgentsLimits.SentWhileParkedRetryDelays[attempt], cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private static bool IsFollowUp(JsonElement evt)
    {
        if (evt.ValueKind != JsonValueKind.Object
            || !evt.TryGetProperty("type", out var type)
            || type.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        return type.GetString() is "user.message" or "system.message";
    }

    /// <summary>
    /// Substring of the API's 400 for an event posted while the session is still parked on tool
    /// results.
    /// </summary>
    /// <remarks>
    /// NOT VERIFIED AGAINST THE LIVE API. The retry this gates exists because a session un-parks
    /// asynchronously after a tool result, so a follow-up message can legitimately race ahead of
    /// that transition; this wording is what the rejection was observed to carry, and the API is
    /// free to reword it. The tests build the error from the real SDK exception class, which pins
    /// the shape (status code plus response body) but not the wording.
    /// <para>
    /// The failure mode is benign and one-directional: a reworded message means the retry no longer
    /// fires and the original 400 surfaces to the caller, never that something else is retried by
    /// mistake. If the parked race starts surfacing as a run error, check this string first.
    /// </para>
    /// </remarks>
    private const string SentWhileParkedMessage = "waiting on responses";

    /// <summary>
    /// Whether the API rejected an event because the session is still parked on tool calls
    /// (HTTP 400 whose message contains <see cref="SentWhileParkedMessage"/>).
    /// </summary>
    private static bool IsSentWhileParked(Exception ex)
    {
        return ex is Anthropic.Exceptions.AnthropicApiException api
            ? api.StatusCode == System.Net.HttpStatusCode.BadRequest
                && api.Message.Contains(SentWhileParkedMessage, StringComparison.Ordinal)
            : ex is ManagedAgentsSendException { StatusCode: (int)System.Net.HttpStatusCode.BadRequest } sent
                && sent.Message.Contains(SentWhileParkedMessage, StringComparison.Ordinal);
    }

    /// <summary>
    /// Closes every open text and reasoning block and returns the pending events, including
    /// the closing ones. Used when the turn throws so the caller can honor the closing invariant.
    /// </summary>
    internal IReadOnlyList<BaseEvent> CloseOpenBlocks()
    {
        CloseAll();
        return Drain().ToList();
    }

    private IEnumerable<BaseEvent> Drain()
    {
        while (_pending.TryDequeue(out var evt))
        {
            yield return evt;
        }
    }

    private void Emit(BaseEvent evt) => _pending.Enqueue(evt);

    private async Task HandleAsync(BetaManagedAgentsStreamSessionEvents streamEvent, CancellationToken cancellationToken)
    {
        if (streamEvent.TryPickStartEvent(out var start))
        {
            HandleEventStart(start);
            return;
        }

        if (streamEvent.TryPickDeltaEvent(out var delta))
        {
            HandleEventDelta(delta, streamEvent.Json);
            return;
        }

        if (streamEvent.TryPickAgentThinkingEvent(out var thinking))
        {
            // The thinking stretch finished. Its text is not exposed by the API today, so this
            // is a progress signal: close the reasoning block we opened.
            if (_openReasoning.Contains(thinking.ID))
            {
                CloseReasoning(thinking.ID);
            }
            else
            {
                Emit(new ReasoningStartEvent { MessageId = thinking.ID });
                Emit(new ReasoningEndEvent { MessageId = thinking.ID });
            }

            return;
        }

        if (streamEvent.TryPickAgentMessageEvent(out var message))
        {
            HandleAgentMessage(message.ID, streamEvent.Json);
            return;
        }

        if (streamEvent.TryPickAgentCustomToolUseEvent(out var customToolUse))
        {
            await HandleCustomToolUseAsync(customToolUse.ID, customToolUse.Name, InputJsonOf(streamEvent.Json), cancellationToken).ConfigureAwait(false);
            return;
        }

        if (streamEvent.TryPickAgentToolUseEvent(out var toolUse))
        {
            EmitToolCall(toolUse.ID, toolUse.Name, InputJsonOf(streamEvent.Json));
            if (string.Equals(toolUse.EvaluatedPermission?.Raw(), "ask", StringComparison.Ordinal))
            {
                _askedConfirmations.Add(toolUse.ID);
            }

            return;
        }

        if (streamEvent.TryPickAgentMcpToolUseEvent(out var mcpToolUse))
        {
            EmitToolCall(mcpToolUse.ID, $"{mcpToolUse.McpServerName}: {mcpToolUse.Name}", InputJsonOf(streamEvent.Json));
            if (string.Equals(mcpToolUse.EvaluatedPermission?.Raw(), "ask", StringComparison.Ordinal))
            {
                _askedConfirmations.Add(mcpToolUse.ID);
            }

            return;
        }

        if (streamEvent.TryPickAgentToolResultEvent(out var toolResult))
        {
            EmitToolResult(toolResult.ToolUseID, DescribeContent(streamEvent.Json));
            return;
        }

        if (streamEvent.TryPickAgentMcpToolResultEvent(out var mcpToolResult))
        {
            EmitToolResult(mcpToolResult.McpToolUseID, DescribeContent(streamEvent.Json));
            return;
        }

        if (streamEvent.TryPickSpanModelRequestEndEvent(out var spanEnd))
        {
            // A failed model request produces no buffered agent.message, so its
            // dangling preview must be closed here. A successful one is left to
            // the buffered message, which may arrive after this event and still
            // needs to reconcile the streamed text.
            if (spanEnd.IsError == true)
            {
                CloseAll();
            }

            return;
        }

        if (streamEvent.TryPickSessionErrorEvent(out var sessionError))
        {
            HandleSessionError(sessionError.Error.Json);
            return;
        }

        if (streamEvent.TryPickSessionStatusIdleEvent(out var idle))
        {
            await HandleIdleAsync(idle.StopReason).ConfigureAwait(false);
            return;
        }

        if (streamEvent.TryPickSessionStatusTerminatedEvent(out _) || streamEvent.TryPickSessionDeletedEvent(out _))
        {
            CloseAll();
            Emit(new RunErrorEvent
            {
                Message = "The managed session ended on the server. Send another message to start a fresh one.",
                Code = "session_ended",
            });
            Finish(ManagedAgentsTurnOutcome.ErroredSessionEnded);
            return;
        }

        // status_running, rescheduled, spans, thread events, echoed user events: ignored.
    }

    private void HandleEventStart(BetaManagedAgentsStartEvent start)
    {
        if (start.Event.TryPickAgentMessage(out var preview))
        {
            Emit(new TextMessageStartEvent { MessageId = preview.ID, Role = AGUIRoles.Assistant });
            _previews[preview.ID] = new StringBuilder();
        }
        else if (start.Event.TryPickAgentThinking(out var thinkingPreview))
        {
            OpenReasoning(thinkingPreview.ID);
            Emit(new ReasoningStartEvent { MessageId = thinkingPreview.ID });
            Emit(new ReasoningMessageStartEvent { MessageId = thinkingPreview.ID, Role = AGUIRoles.Reasoning });
        }
    }

    private void HandleEventDelta(BetaManagedAgentsDeltaEvent delta, JsonElement rawEvent)
    {
        if (!_previews.TryGetValue(delta.EventID, out var preview))
        {
            return; // best-effort; the buffered agent.message is canonical
        }

        // AG-UI rejects a content event with an empty delta, so skip empty text.
        var text = TextDeltaOf(rawEvent);
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        preview.Append(text);
        Emit(new TextMessageContentEvent { MessageId = delta.EventID, Delta = text });
    }

    private void HandleAgentMessage(string messageId, JsonElement rawEvent)
    {
        if (_closedMessages.Contains(messageId))
        {
            return;
        }

        var finalText = ManagedAgentsText.TextOf(ContentBlocksOf(rawEvent));
        if (!_previews.TryGetValue(messageId, out var preview))
        {
            Emit(new TextMessageStartEvent { MessageId = messageId, Role = AGUIRoles.Assistant });
            if (finalText.Length > 0)
            {
                Emit(new TextMessageContentEvent { MessageId = messageId, Delta = finalText });
            }
        }
        else
        {
            var previewed = preview.ToString();
            if (finalText.StartsWith(previewed, StringComparison.Ordinal))
            {
                if (finalText.Length > previewed.Length)
                {
                    Emit(new TextMessageContentEvent { MessageId = messageId, Delta = finalText.Substring(previewed.Length) });
                }
            }
            else
            {
                // The preview diverged from the final text: close it and re-emit the corrected whole.
                CloseMessage(messageId);
                if (finalText.Length > 0)
                {
                    var corrected = $"corrected_{messageId}";
                    Emit(new TextMessageStartEvent { MessageId = corrected, Role = AGUIRoles.Assistant });
                    Emit(new TextMessageContentEvent { MessageId = corrected, Delta = finalText });
                    Emit(new TextMessageEndEvent { MessageId = corrected });
                }

                return;
            }
        }

        CloseMessage(messageId);
    }

    private async Task HandleCustomToolUseAsync(string toolUseId, string name, string inputJson, CancellationToken cancellationToken)
    {
        // Report the frontend's original tool name, which may differ from the normalized name
        // registered on the managed agent.
        _clientTools.TryGetValue(name, out var originalName);
        EmitToolCall(toolUseId, originalName ?? name, inputJson);
        if (originalName is not null)
        {
            // The frontend executes this tool. Leave it unanswered; the session will park on
            // it and the next run supplies the result.
            _clientParks.Add(toolUseId);
            if (_onClientPark is not null)
            {
                await _onClientPark(toolUseId).ConfigureAwait(false);
            }

            return;
        }

        if (_backendTools.TryGetValue(name, out var backendTool))
        {
            await RunBackendToolAsync(toolUseId, backendTool, inputJson, cancellationToken).ConfigureAwait(false);
            return;
        }

        // Nothing can execute this tool. Answer with an error so the agent recovers.
        await AnswerCustomToolUseAsync(toolUseId, $"No handler is registered for tool \"{name}\".", isError: true).ConfigureAwait(false);
    }

    /// <summary>
    /// Runs a backend tool and posts its result back into the session. If the run is aborted
    /// (client disconnect or turn timeout) while the handler is still running, stops waiting for
    /// it, answers the call with an error so the session is not left parked on it, and rethrows
    /// the cancellation so the abort proceeds.
    /// </summary>
    private async Task RunBackendToolAsync(string toolUseId, ManagedAgentsBackendTool tool, string inputJson, CancellationToken cancellationToken)
    {
        string text;
        var isError = false;
        try
        {
            using var input = JsonDocument.Parse(inputJson);
            var handlerTask = tool.Handler(input.RootElement.Clone());
            try
            {
                text = await handlerTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // The handler keeps running after we stop waiting. Observing its eventual fault
                // keeps it from surfacing as an unobserved task exception — but it is also the
                // only trace of a backend tool that failed after the run walked away, so report
                // it rather than merely consuming it.
                _ = handlerTask.ContinueWith(
                    t =>
                    {
                        if (t.Exception is { } failure)
                        {
                            ReportDetached("abandoned_backend_tool", failure.GetBaseException());
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
                throw;
            }
        }
        catch (Exception ex)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                // The run is being torn down (timeout or disconnect), whatever the
                // exception type: answer the call best-effort so the session is not
                // left parked, then surface the cancellation.
                try
                {
                    await PostCustomToolResultAsync(toolUseId, InterruptedToolResult, isError: true).ConfigureAwait(false);
                }
                catch (Exception postFailure)
                {
                    // Best-effort: the run is already being torn down.
                    await ReportAsync("post_interrupted_tool_result", postFailure).ConfigureAwait(false);
                }
                cancellationToken.ThrowIfCancellationRequested();
                throw;
            }

            // Includes an OperationCanceledException the handler threw on its own
            // (e.g. an inner HTTP timeout): the session is waiting on this call,
            // so it must still be answered.
            isError = true;
            text = string.IsNullOrEmpty(ex.Message) ? ex.GetType().Name : ex.Message;
        }

        await AnswerCustomToolUseAsync(toolUseId, text, isError).ConfigureAwait(false);
    }

    /// <summary>
    /// Posts a custom tool's result into the session. The post ignores the run's cancellation —
    /// the tool already ran (or was answered) and the session is waiting on the result — but is
    /// bounded by its own timeout so a stalled connection cannot hold the thread's run gate open.
    /// </summary>
    private async Task PostCustomToolResultAsync(string toolUseId, string text, bool isError)
    {
        using var sendTimeout = new CancellationTokenSource(ManagedAgentsLimits.BestEffortSendTimeout);
        await _client
            .SendEventsAsync(_sessionId, [ManagedAgentsSessionEvents.CustomToolResult(toolUseId, text, isError)], sendTimeout.Token)
            .ConfigureAwait(false);
        _ackedToolUses.Add(toolUseId);
    }

    /// <summary>
    /// Answers a custom tool call: delivers the result into the session first, and only tells the
    /// UI once it landed. A <c>TOOL_CALL_RESULT</c> the agent never received would report a
    /// success that did not happen, so on a failed delivery the session — still parked on the
    /// call — is interrupted best-effort and the run ends with an error instead.
    /// </summary>
    private async Task AnswerCustomToolUseAsync(string toolUseId, string text, bool isError)
    {
        try
        {
            await PostCustomToolResultAsync(toolUseId, text, isError).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // The failure itself goes to the hook; the client is told only that the delivery
            // failed. The underlying exception can carry session ids and request detail, and this
            // event is read by the browser.
            await ReportAsync("post_tool_result", ex).ConfigureAwait(false);
            var interrupted = await InterruptAsync().ConfigureAwait(false);
            Fail(
                $"The result of tool call {toolUseId} could not be delivered to the session.",
                "tool_result_delivery_failed",
                interrupted);
            return;
        }

        EmitToolResult(toolUseId, text);
    }

    private void HandleSessionError(JsonElement error)
    {
        var retryType = error.TryGetProperty("retry_status", out var retryStatus) && retryStatus.ValueKind == JsonValueKind.Object
            ? StringPropertyOf(retryStatus, "type")
            : null;
        if (string.Equals(retryType, "retrying", StringComparison.Ordinal))
        {
            return; // transient; the session recovers on its own
        }

        var message = StringPropertyOf(error, "message");
        Fail(string.IsNullOrEmpty(message) ? "The session reported an error." : message, StringPropertyOf(error, "type"));
    }

    private async Task HandleIdleAsync(StopReason stopReason)
    {
        if (stopReason.TryPickBetaManagedAgentsSessionEndTurn(out _))
        {
            CloseAll();
            Finish(ManagedAgentsTurnOutcome.Finished);
            return;
        }

        if (stopReason.TryPickBetaManagedAgentsSessionRetriesExhausted(out _))
        {
            Fail("The session gave up after exhausting its retries.", "retries_exhausted");
            return;
        }

        if (!stopReason.TryPickBetaManagedAgentsSessionRequiresAction(out var requiresAction))
        {
            // A stop reason this version does not know how to answer. Ignoring it left the turn
            // waiting on a session that will never resume until the timeout fired, so interrupt it
            // and say so — the same as the other two ports.
            var interrupted = await InterruptAsync().ConfigureAwait(false);
            Fail(
                "The session went idle for a reason this integration does not handle: "
                    + (StringPropertyOf(stopReason.Json, "type") ?? "unknown") + ".",
                "unknown_stop_reason",
                interrupted);
            return;
        }

        // requires_action: work out what the session is blocked on.
        var blockedOn = requiresAction.EventIds.Where(id => !_ackedToolUses.Contains(id)).ToList();
        if (blockedOn.Count == 0)
        {
            return; // everything is already answered; wait for it to resume
        }

        var confirmations = blockedOn.Where(id => _askedConfirmations.Contains(id)).ToList();
        if (confirmations.Count > 0)
        {
            if (_toolConfirmation is null)
            {
                var interrupted = await InterruptAsync().ConfigureAwait(false);
                Fail(
                    "A tool requires confirmation but no confirmation policy is configured. " +
                    "Set `ToolConfirmation` to \"allow\" or \"deny\", or use a permission policy that does not ask.",
                    "tool_confirmation_required",
                    interrupted);
                return;
            }

            var events = confirmations
                .Select(id => ManagedAgentsSessionEvents.ToolConfirmation(id, _toolConfirmation))
                .ToList();

            // Ignores the run's cancellation (the session is parked waiting on these answers) but
            // bounded so a stalled connection cannot hang the turn. A failed delivery leaves the
            // session parked, so interrupt it and report that cause — in particular, the bound's
            // own TaskCanceledException must not escape and degrade the run to run_failed.
            try
            {
                using var sendTimeout = new CancellationTokenSource(ManagedAgentsLimits.BestEffortSendTimeout);
                await _client.SendEventsAsync(_sessionId, events, sendTimeout.Token).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                await ReportAsync("post_tool_confirmation", ex).ConfigureAwait(false);
                var confirmationInterrupted = await InterruptAsync().ConfigureAwait(false);
                Fail(
                    "The tool confirmation could not be delivered to the session.",
                    "tool_confirmation_delivery_failed",
                    confirmationInterrupted);
                return;
            }

            foreach (var id in confirmations)
            {
                _ackedToolUses.Add(id);
            }

            if (confirmations.Count == blockedOn.Count)
            {
                return;
            }
        }

        var clientToolUseIds = blockedOn.Where(id => _clientParks.Contains(id)).ToList();
        var unknown = blockedOn.Where(id => !_askedConfirmations.Contains(id) && !_clientParks.Contains(id)).ToList();
        if (unknown.Count > 0)
        {
            var unknownInterrupted = await InterruptAsync().ConfigureAwait(false);
            Fail(
                "The agent is waiting on an action this integration cannot answer.",
                "unsupported_action",
                unknownInterrupted);
            return;
        }

        if (clientToolUseIds.Count > 0)
        {
            // Hand control back to the frontend to execute its tools.
            CloseAll();
            Finish(ManagedAgentsTurnOutcome.Parked(clientToolUseIds));
        }
    }

    /// <summary>
    /// Stops the session best-effort. Deliberately not tied to the run's cancellation — the point
    /// is to reach a session the run is walking away from — but bounded by its own timeout so a
    /// stalled connection cannot hold the thread's run gate open indefinitely.
    /// </summary>
    private async Task<bool> InterruptAsync()
    {
        try
        {
            using var sendTimeout = new CancellationTokenSource(ManagedAgentsLimits.BestEffortSendTimeout);
            await _client
                .SendEventsAsync(_sessionId, [ManagedAgentsSessionEvents.Interrupt()], sendTimeout.Token)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Best effort: the run is already failing and must still report why. The send does
            // not observe the run's token, so an OperationCanceledException here is the HTTP
            // client's own timeout — letting it escape would replace the real cause (a tool
            // confirmation the caller cannot answer, an unsupported action) with run_failed.
            await ReportAsync("interrupt", ex).ConfigureAwait(false);
            return false;
        }

        return true;
    }

    private void EmitToolCall(string toolCallId, string toolCallName, string inputJson)
    {
        Emit(new ToolCallStartEvent { ToolCallId = toolCallId, ToolCallName = toolCallName });
        Emit(new ToolCallArgsEvent { ToolCallId = toolCallId, Delta = inputJson });
        Emit(new ToolCallEndEvent { ToolCallId = toolCallId });
    }

    private void EmitToolResult(string toolUseId, string content)
    {
        Emit(new ToolCallResultEvent
        {
            MessageId = $"result_{toolUseId}",
            ToolCallId = toolUseId,
            Content = content,
            Role = AGUIRoles.Tool,
        });
    }

    /// <summary>
    /// Ends the turn with a <c>RUN_ERROR</c>. <paramref name="sessionInterrupted"/> must be the
    /// result of the <see cref="InterruptAsync"/> that preceded it: a landed interrupt invalidates
    /// every park recorded this turn, and a failed one leaves the session parked.
    /// </summary>
    private void Fail(string message, string? code = null, bool sessionInterrupted = false)
    {
        CloseAll();
        Emit(new RunErrorEvent { Message = message, Code = code });
        Finish(ManagedAgentsTurnOutcome.ErroredWith(sessionInterrupted));
    }

    private void Finish(ManagedAgentsTurnOutcome outcome)
    {
        Outcome = outcome;
        _done = true;
    }

    private void CloseMessage(string messageId)
    {
        Emit(new TextMessageEndEvent { MessageId = messageId });
        _previews.Remove(messageId);
        _closedMessages.Add(messageId);
    }

    private void OpenReasoning(string messageId)
    {
        if (_openReasoning.Add(messageId))
        {
            _openReasoningOrder.Add(messageId);
        }
    }

    private void CloseReasoning(string messageId)
    {
        Emit(new ReasoningMessageEndEvent { MessageId = messageId });
        Emit(new ReasoningEndEvent { MessageId = messageId });
        _openReasoning.Remove(messageId);
        _openReasoningOrder.Remove(messageId);
    }

    private void CloseAll()
    {
        foreach (var messageId in _previews.Keys.ToList())
        {
            CloseMessage(messageId);
        }

        foreach (var reasoningId in _openReasoningOrder.ToList())
        {
            CloseReasoning(reasoningId);
        }
    }

    /// <summary>
    /// Compact JSON with no escaping beyond what JSON itself requires — the same bytes
    /// <c>JSON.stringify</c> and <c>json.dumps(..., ensure_ascii=False)</c> produce in the other
    /// two ports. <see cref="JsonSerializer"/>'s default encoder escapes HTML-sensitive
    /// characters, which would send <c>&lt;</c> to the UI as <c>\u003C</c> from .NET alone.
    /// </summary>
    private static readonly JsonSerializerOptions s_toolArgsJson = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// The tool input as JSON text for <c>TOOL_CALL_ARGS</c>.
    /// </summary>
    private static string InputJsonOf(JsonElement rawEvent)
    {
        if (rawEvent.ValueKind == JsonValueKind.Object
            && rawEvent.TryGetProperty("input", out var input)
            && input.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
        {
            return JsonSerializer.Serialize(input, s_toolArgsJson);
        }

        return "{}";
    }

    private static IEnumerable<JsonElement>? ContentBlocksOf(JsonElement rawEvent)
    {
        if (rawEvent.ValueKind == JsonValueKind.Object
            && rawEvent.TryGetProperty("content", out var content)
            && content.ValueKind == JsonValueKind.Array)
        {
            return content.EnumerateArray().Select(static block => block.Clone());
        }

        return null;
    }

    private static string DescribeContent(JsonElement rawEvent)
    {
        return ManagedAgentsText.Truncate(ManagedAgentsText.DescribeToolResult(ContentBlocksOf(rawEvent)), ManagedAgentsLimits.ToolResultMaxChars);
    }

    private static string? TextDeltaOf(JsonElement rawEvent)
    {
        if (rawEvent.ValueKind != JsonValueKind.Object
            || !rawEvent.TryGetProperty("delta", out var delta)
            || delta.ValueKind != JsonValueKind.Object
            || !string.Equals(StringPropertyOf(delta, "type"), "content_delta", StringComparison.Ordinal)
            || !delta.TryGetProperty("content", out var content)
            || content.ValueKind != JsonValueKind.Object
            || !string.Equals(StringPropertyOf(content, "type"), "text", StringComparison.Ordinal))
        {
            return null;
        }

        return StringPropertyOf(content, "text");
    }

    private static string? StringPropertyOf(JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var property)
            && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
    }
}
