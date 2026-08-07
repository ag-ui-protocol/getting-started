using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

/// <summary>
/// Extension methods for converting <see cref="ChatResponseUpdate"/> streams to AG-UI event streams.
/// </summary>
public static class ChatResponseUpdateAGUIExtensions
{
    private static readonly JsonElement AGUIToolApprovalSchema =
        JsonDocument.Parse("""
            {
                "type": "object",
                "properties": {
                    "approved": { "type": "boolean" }
                },
                "required": ["approved"]
            }
            """).RootElement.Clone();

    /// <summary>
    /// Converts a stream of <see cref="ChatResponseUpdate"/> instances to a stream of AG-UI <see cref="BaseEvent"/> instances.
    /// </summary>
    /// <param name="updates">The stream of chat response updates.</param>
    /// <param name="context">The request context produced by <see cref="RunAgentInputExtensions.ToChatRequestContext"/>.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>An async enumerable of AG-UI events.</returns>
    /// <remarks>
    /// When a listener is subscribed to the <see cref="AGUIServerInstrumentation.ActivitySourceName"/>
    /// source, the produced run is wrapped in an <c>agui.run</c> span; otherwise there is no tracing overhead.
    /// </remarks>
    public static IAsyncEnumerable<BaseEvent> AsAGUIEventStreamAsync(
        this IAsyncEnumerable<ChatResponseUpdate> updates,
        ChatRequestContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(updates);
        ArgumentNullException.ThrowIfNull(context);

        return AGUIServerInstrumentation.ActivitySource.HasListeners()
            ? InstrumentedAsync(updates, context, cancellationToken)
            : CoreAsync(updates, context, cancellationToken);
    }

    private const string RunOutcomeSuccess = "success";
    private const string RunOutcomeInterrupt = "interrupt";
    private const string RunOutcomeError = "error";

    private static async IAsyncEnumerable<BaseEvent> InstrumentedAsync(
        IAsyncEnumerable<ChatResponseUpdate> updates,
        ChatRequestContext context,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var input = context.Input;
        using var activity = AGUIServerInstrumentation.ActivitySource.StartActivity("agui.run", ActivityKind.Internal);

        if (activity is not null)
        {
            activity.SetTag("agui.thread_id", input.ThreadId);
            activity.SetTag("agui.run_id", input.RunId);
            if (!string.IsNullOrEmpty(input.ParentRunId))
            {
                activity.SetTag("agui.parent_run_id", input.ParentRunId);
            }

            if (context.IsContinuation)
            {
                activity.SetTag("agui.continuation", true);
            }
        }

        var eventCount = 0;
        var outcome = RunOutcomeSuccess;

        var enumerator = CoreAsync(updates, context, cancellationToken).GetAsyncEnumerator(cancellationToken);
        try
        {
            while (true)
            {
                BaseEvent current;
                try
                {
                    if (!await enumerator.MoveNextAsync().ConfigureAwait(false))
                    {
                        break;
                    }

                    current = enumerator.Current;
                }
                catch (Exception ex)
                {
                    RecordError(activity, ex, eventCount);
                    throw;
                }

                eventCount++;
                outcome = current switch
                {
                    RunFinishedEvent { Outcome: RunFinishedInterruptOutcome } => RunOutcomeInterrupt,
                    RunErrorEvent => RunOutcomeError,
                    _ => outcome,
                };

                yield return current;
            }
        }
        finally
        {
            await enumerator.DisposeAsync().ConfigureAwait(false);

            if (activity is not null && activity.Status != ActivityStatusCode.Error)
            {
                activity.SetTag("agui.run.outcome", outcome);
                activity.SetTag("agui.events.count", eventCount);
                if (outcome == RunOutcomeError)
                {
                    activity.SetStatus(ActivityStatusCode.Error);
                }
            }
        }
    }

    private static void RecordError(Activity? activity, Exception exception, int eventCount)
    {
        if (activity is null)
        {
            return;
        }

        activity.SetTag("error.type", exception.GetType().FullName);
        activity.SetTag("agui.run.outcome", RunOutcomeError);
        activity.SetTag("agui.events.count", eventCount);
        activity.SetStatus(ActivityStatusCode.Error, exception.Message);
    }

    private static async IAsyncEnumerable<BaseEvent> CoreAsync(
        IAsyncEnumerable<ChatResponseUpdate> updates,
        ChatRequestContext context,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var threadId = context.Input.ThreadId;
        var runId = context.Input.RunId;
        var options = context.StreamOptions;
        var jsonSerializerOptions = context.JsonSerializerOptions;
        var isContinuation = context.IsContinuation;
        var clientToolNames = context.ClientToolNames;

        bool runStartedEmitted = false;
        bool runFinishedEmitted = false;
        var messageTracker = new TextMessageTracker();
        var reasoningTracker = new ReasoningMessageTracker();

        // Track tool call IDs → tool names for correlating results with registered mappings.
        Dictionary<string, string>? callIdToToolName = null;

        // Accumulate interrupts so we can emit a single RunFinished with all of them.
        // Includes both tool-approval interrupts (from ToolApprovalRequestContent) and
        // generic input interrupts (from InterruptRequestContent).
        List<AGUIInterrupt>? pendingInterrupts = null;

        // Progressive tool-call argument streaming. MEAI coalesces tool-call arguments and
        // only attaches the typed FunctionCallContent once a call is complete, so without a
        // registered fragment extractor the wire carries one atomic TOOL_CALL_ARGS per call.
        // When an extractor is registered, surface the per-chunk fragments as incremental
        // TOOL_CALL_ARGS events and suppress the duplicate atomic emission. Two views of the
        // open calls: by provider index (for later fragments + the end-of-stream sweep) and
        // by call id (for an O(1) close when the coalesced FunctionCallContent arrives).
        bool streamToolArgs = options.TryGetToolCallArgumentExtractor(out var extractToolArgFragments);
        Dictionary<int, string> rawToolCallIdsByIndex = streamToolArgs ? new() : null!;
        Dictionary<string, int> rawToolCallIndexById = streamToolArgs ? new(StringComparer.Ordinal) : null!;

        await foreach (var chatResponse in updates.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            // Check if RawRepresentation contains an AG-UI event - emit it directly.
            if (chatResponse.RawRepresentation is BaseEvent rawEvent)
            {
                if (rawEvent is RunStartedEvent)
                {
                    runStartedEmitted = true;
                }
                else if (rawEvent is RunFinishedEvent)
                {
                    runFinishedEmitted = true;
                }
                else if (!runStartedEmitted)
                {
                    runStartedEmitted = true;
                    yield return RunStartedEvent.Create(threadId, runId, context.Input.ParentRunId);
                }

                yield return rawEvent;
                continue;
            }

            // Emit RunStartedEvent automatically if not explicitly provided
            if (!runStartedEmitted)
            {
                runStartedEmitted = true;
                yield return RunStartedEvent.Create(threadId, runId, context.Input.ParentRunId);
            }

            // Serialize the raw ChatResponseUpdate once for attaching to emitted events
            var raw = JsonSerializer.SerializeToElement(chatResponse, jsonSerializerOptions.GetTypeInfo(typeof(ChatResponseUpdate)));

            // Surface provider-native streamed tool-call argument fragments incrementally.
            if (streamToolArgs && extractToolArgFragments(chatResponse) is { } fragments)
            {
                foreach (var fragment in fragments)
                {
                    var haveIndex = rawToolCallIdsByIndex.TryGetValue(fragment.Index, out var rawToolCallId);

                    // A new first fragment (only first fragments carry the function name) that
                    // reuses an index still held by a prior, never-coalesced call means the prior
                    // call at that index ended without its typed FunctionCallContent — e.g. a
                    // mid-stream provider error on a retried sub-agent turn, where providers
                    // restart tool-call indexes at 0 (and may even reuse the same id). Close the
                    // stale call so the next call's fragments are not misattributed to it (and its
                    // later coalesced FunctionCallContent no longer double-emits).
                    if (haveIndex && !string.IsNullOrEmpty(fragment.FunctionName))
                    {
                        yield return ToolCallEndEvent.Create(rawToolCallId!, raw);
                        rawToolCallIndexById.Remove(rawToolCallId!);
                        rawToolCallIdsByIndex.Remove(fragment.Index);
                        haveIndex = false;
                    }

                    if (!haveIndex)
                    {
                        // The first fragment of a call carries its id and function name;
                        // later fragments only carry the index plus an arguments delta.
                        if (string.IsNullOrEmpty(fragment.ToolCallId) || string.IsNullOrEmpty(fragment.FunctionName))
                        {
                            continue;
                        }

                        rawToolCallId = fragment.ToolCallId;
                        rawToolCallIdsByIndex[fragment.Index] = rawToolCallId;
                        rawToolCallIndexById[rawToolCallId] = fragment.Index;

                        // Close any open text/reasoning block before emitting tool events.
                        if (messageTracker.Close(raw) is { } fragTextEndEvt)
                        {
                            yield return fragTextEndEvt;
                        }

                        foreach (var reasonCloseEvt in reasoningTracker.Close())
                        {
                            yield return reasonCloseEvt;
                        }

                        yield return ToolCallStartEvent.Create(rawToolCallId, fragment.FunctionName!, chatResponse.MessageId, raw);
                    }

                    if (fragment.ArgumentsDelta.Length > 0)
                    {
                        yield return ToolCallArgsEvent.Create(rawToolCallId!, fragment.ArgumentsDelta, raw);
                    }
                }
            }

            string? effectiveMessageId = null;
            foreach (var content in chatResponse.Contents)
            {
                switch (content)
                {
                    case TextReasoningContent reasoningContent:
                        if (messageTracker.Close(raw) is { } reasonTextEndEvt)
                        {
                            yield return reasonTextEndEvt;
                        }

                        if (reasoningContent.ProtectedData is { Length: > 0 } encrypted)
                        {
                            yield return reasoningTracker.EmitEncryptedValue(encrypted, raw);
                        }

                        if (!string.IsNullOrEmpty(reasoningContent.Text))
                        {
                            foreach (var openEvt in reasoningTracker.Open())
                            {
                                yield return openEvt;
                            }

                            yield return reasoningTracker.EmitDelta(reasoningContent.Text);
                        }
                        break;

                    case TextContent textContent:
                        foreach (var reasonCloseEvt in reasoningTracker.Close())
                        {
                            yield return reasonCloseEvt;
                        }

                        effectiveMessageId ??= chatResponse.MessageId ?? AGUIIdGenerator.NewMessageId();

                        if (!messageTracker.IsMessageId(effectiveMessageId))
                        {
                            if (messageTracker.Close(raw) is { } textEndEvt)
                            {
                                yield return textEndEvt;
                            }

                            yield return messageTracker.Open(
                                effectiveMessageId,
                                MapAGUIRole(chatResponse.Role) ?? AGUIRoles.Assistant,
                                chatResponse.AuthorName,
                                raw);
                        }

                        if (!string.IsNullOrEmpty(textContent.Text))
                        {
                            yield return messageTracker.EmitDelta(textContent.Text, raw);
                        }
                        break;

                    case FunctionCallContent fcc:

                        // This call's arguments already streamed incrementally from the raw
                        // fragments above — only the closing event remains. Release the
                        // per-call state: providers restart tool-call indexes at 0 each turn,
                        // so a stale entry would absorb a later round's fragments into this
                        // finished call.
                        if (streamToolArgs && rawToolCallIndexById.Remove(fcc.CallId, out var closedIndex))
                        {
                            rawToolCallIdsByIndex.Remove(closedIndex);

                            if (messageTracker.Close(raw) is { } rawFccEndEvt)
                            {
                                yield return rawFccEndEvt;
                            }

                            foreach (var reasonRawCloseEvt in reasoningTracker.Close())
                            {
                                yield return reasonRawCloseEvt;
                            }

                            yield return ToolCallEndEvent.Create(fcc.CallId, raw);

                            // Emit the mapped call events the atomic path emits, so a registered
                            // MapCall mapper is not silently skipped for a tool whose arguments
                            // streamed as fragments.
                            if (options.TryGetCallMapping(fcc.Name, out var rawCallMapper))
                            {
                                foreach (var mappedEvt in rawCallMapper(fcc))
                                {
                                    yield return mappedEvt;
                                }
                            }

                            // Preserve result-mapping correlation the atomic path performs.
                            if (options.TryGetResultMapping(fcc.Name, out _))
                            {
                                callIdToToolName ??= new Dictionary<string, string>(StringComparer.Ordinal);
                                callIdToToolName[fcc.CallId] = fcc.Name;
                            }

                            break;
                        }

                        // On continuation, suppress re-emitted FCCs (client already has them from turn 1)
                        if (isContinuation)
                        {
                            // Still track for correlating FRCs later
                            callIdToToolName ??= new Dictionary<string, string>(StringComparer.Ordinal);
                            callIdToToolName[fcc.CallId] = fcc.Name;
                            break;
                        }

                        // Close any open text message before emitting tool call events
                        if (messageTracker.Close(raw) is { } fccEndEvt)
                        {
                            yield return fccEndEvt;
                        }

                        foreach (var reasonFccCloseEvt in reasoningTracker.Close())
                        {
                            yield return reasonFccCloseEvt;
                        }

                        yield return ToolCallStartEvent.Create(fcc.CallId, fcc.Name, chatResponse.MessageId, raw);

                        var args = JsonSerializer.Serialize(fcc.Arguments, jsonSerializerOptions.GetTypeInfo(typeof(IDictionary<string, object?>)));
                        yield return ToolCallArgsEvent.Create(fcc.CallId, args, raw);

                        yield return ToolCallEndEvent.Create(fcc.CallId, raw);

                        // Emit mapped events for this tool call if a call mapping is registered
                        if (options.TryGetCallMapping(fcc.Name, out var callMapper))
                        {
                            foreach (var mappedEvt in callMapper(fcc))
                            {
                                yield return mappedEvt;
                            }
                        }

                        // Track call ID → tool name for correlating results with registered result mappings
                        if (options.TryGetResultMapping(fcc.Name, out _))
                        {
                            callIdToToolName ??= new Dictionary<string, string>(StringComparer.Ordinal);
                            callIdToToolName[fcc.CallId] = fcc.Name;
                        }
                        break;

                    case FunctionResultContent frc:
                        // On continuation, suppress client tool results (client already has them)
                        if (isContinuation
                            && callIdToToolName is not null
                            && callIdToToolName.TryGetValue(frc.CallId, out var frcToolName)
                            && clientToolNames.Contains(frcToolName))
                        {
                            break;
                        }

                        foreach (var reasonFrcCloseEvt in reasoningTracker.Close())
                        {
                            yield return reasonFrcCloseEvt;
                        }

                        var result = SerializeResultContent(frc, jsonSerializerOptions) ?? "";
                        yield return ToolCallResultEvent.Create(frc.CallId, result, raw);

                        // Emit mapped events for this tool result if a result mapping is registered
                        if (callIdToToolName is not null
                            && callIdToToolName.TryGetValue(frc.CallId, out var mappedToolName)
                            && options.TryGetResultMapping(mappedToolName, out var resultMapper))
                        {
                            foreach (var mappedEvt in resultMapper(frc))
                            {
                                yield return mappedEvt;
                            }
                        }
                        break;

                    case ToolApprovalRequestContent { ToolCall: FunctionCallContent toolCall } ar:

                        // Close any open text message before emitting tool call events
                        if (messageTracker.Close(raw) is { } arEndEvt)
                        {
                            yield return arEndEvt;
                        }

                        foreach (var reasonArCloseEvt in reasoningTracker.Close())
                        {
                            yield return reasonArCloseEvt;
                        }

                        // Emit the tool call events so spec-compliant clients can see the proposal
                        yield return ToolCallStartEvent.Create(toolCall.CallId, toolCall.Name, chatResponse.MessageId, raw);

                        var approvalArgs = JsonSerializer.Serialize(toolCall.Arguments, jsonSerializerOptions.GetTypeInfo(typeof(IDictionary<string, object?>)));
                        yield return ToolCallArgsEvent.Create(toolCall.CallId, approvalArgs, raw);

                        yield return ToolCallEndEvent.Create(toolCall.CallId, raw);

                        // A client tool is owned and gated by the client, never the server. Always
                        // surface its call as a plain TOOL_CALL (the run finishes with success) so
                        // the client executes it — including when the model re-invokes it on a
                        // continuation (where it arrives wrapped as an approval request).
                        if (clientToolNames.Contains(toolCall.Name))
                        {
                            break;
                        }

                        // In mixed invocation (first turn), don't accumulate interrupts.
                        // The stream will finish with RUN_FINISHED(success) instead.
                        if (clientToolNames.Count > 0 && !isContinuation)
                        {
                            break;
                        }

                        // Accumulate the interrupt — we'll emit a single RunFinished with all interrupts at the end
                        pendingInterrupts ??= new List<AGUIInterrupt>();
                        pendingInterrupts.Add(new AGUIInterrupt
                        {
                            Id = ar.RequestId,
                            Reason = InterruptReasons.ToolCall,
                            ToolCallId = toolCall.CallId,
                            Message = $"Approval required for tool call: {toolCall.Name}",
                            ResponseSchema = AGUIToolApprovalSchema,
                        });
                        break;

                    case InterruptRequestContent ireq:
                        // Close any open text/reasoning streams before accumulating the interrupt.
                        if (messageTracker.Close(raw) is { } ireqTextEndEvt)
                        {
                            yield return ireqTextEndEvt;
                        }

                        foreach (var reasonIreqCloseEvt in reasoningTracker.Close())
                        {
                            yield return reasonIreqCloseEvt;
                        }

                        // Accumulate the interrupt — we'll emit a single RunFinished with all interrupts at the end.
                        pendingInterrupts ??= new List<AGUIInterrupt>();
                        pendingInterrupts.Add(new AGUIInterrupt
                        {
                            Id = ireq.RequestId,
                            Reason = ireq.Reason ?? InterruptReasons.InputRequired,
                            Message = ireq.Message,
                            ToolCallId = ireq.ToolCallId,
                            ResponseSchema = ireq.ResponseSchema,
                            ExpiresAt = ireq.ExpiresAt,
                            Metadata = ireq.Metadata,
                        });
                        break;

                    default:
                        // Check registered interrupt mappers for custom interrupt-producing content types
                        var interrupt = options.InvokeInterruptMappers(content);
                        if (interrupt is not null)
                        {
                            // Close any open text/reasoning message before accumulating the interrupt.
                            if (messageTracker.Close(raw) is { } intEndEvt)
                            {
                                yield return intEndEvt;
                            }

                            foreach (var reasonIntCloseEvt in reasoningTracker.Close())
                            {
                                yield return reasonIntCloseEvt;
                            }

                            // Accumulate alongside any built-in (tool-approval / InterruptRequestContent)
                            // interrupts so the stream still ends with a single RunFinished carrying every
                            // interrupt, rather than emitting a second RunFinished here.
                            pendingInterrupts ??= new List<AGUIInterrupt>();
                            pendingInterrupts.Add(interrupt);
                        }
                        else
                        {
                            var events = options.InvokeContentMappers(content);
                            if (events is not null)
                            {
                                foreach (var evt in events)
                                {
                                    if (evt is RunFinishedEvent)
                                    {
                                        runFinishedEmitted = true;
                                    }

                                    yield return evt;
                                }
                            }
                        }
                        break;
                }
            }
        }

        // Close any raw-streamed tool call whose coalesced FunctionCallContent never arrived
        // (stream cut short, or a pipeline that does not re-emit the typed content). Without
        // this sweep the wire carries Start/Args with no End and consumers stay "in progress".
        // Sweep in provider index order so the close events are deterministic.
        if (streamToolArgs && rawToolCallIdsByIndex.Count > 0)
        {
            var openIndexes = new List<int>(rawToolCallIdsByIndex.Keys);
            openIndexes.Sort();
            foreach (var openIndex in openIndexes)
            {
                yield return ToolCallEndEvent.Create(rawToolCallIdsByIndex[openIndex]);
            }
        }

        // End the last message if there was one
        if (messageTracker.Close() is { } finalEndEvt)
        {
            yield return finalEndEvt;
        }

        foreach (var finalReasoningCloseEvt in reasoningTracker.Close())
        {
            yield return finalReasoningCloseEvt;
        }

        // Emit RunStartedEvent if no updates were processed (empty stream)
        if (!runStartedEmitted)
        {
            yield return RunStartedEvent.Create(threadId, runId, context.Input.ParentRunId);
        }

        // Emit accumulated tool approval interrupts as a single RunFinished
        if (pendingInterrupts is { Count: > 0 })
        {
            yield return RunFinishedEvent.Create(threadId, runId,
                new RunFinishedInterruptOutcome { Interrupts = pendingInterrupts });
            runFinishedEmitted = true;
        }

        // Emit RunFinishedEvent automatically if not explicitly provided
        if (!runFinishedEmitted)
        {
            yield return RunFinishedEvent.Create(threadId, runId, new RunFinishedSuccessOutcome());
        }
    }

    private static string? SerializeResultContent(FunctionResultContent frc, JsonSerializerOptions options)
    {
        return frc.Result switch
        {
            null => null,
            string str => str,
            JsonElement jsonElement => jsonElement.GetRawText(),
            _ => JsonSerializer.Serialize(frc.Result, options.GetTypeInfo(frc.Result.GetType())),
        };
    }

    private static string? MapAGUIRole(ChatRole? role)
    {
        if (role is null)
        {
            return null;
        }

        if (role == ChatRole.Assistant)
        {
            return AGUIRoles.Assistant;
        }

        if (role == ChatRole.User)
        {
            return AGUIRoles.User;
        }

        if (role == ChatRole.System)
        {
            return AGUIRoles.System;
        }

        if (role == ChatRole.Tool)
        {
            return AGUIRoles.Tool;
        }

        return role.Value.Value.ToLowerInvariant();
    }
}
