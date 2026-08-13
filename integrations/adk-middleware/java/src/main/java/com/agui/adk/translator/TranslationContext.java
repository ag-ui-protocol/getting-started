package com.agui.adk.translator;

import com.google.genai.types.FunctionResponse;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingToolCallEmitter;
import com.agui.adk.state.StateProjector;
import com.agui.adk.translator.context.PredictiveState;
import com.agui.adk.translator.context.StreamingState;
import com.agui.adk.translator.context.ToolState;
import com.agui.community.core.event.ToolCallChunkEvent;
import io.reactivex.rxjava3.core.Flowable;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Holds the state for one ADK-to-AG-UI translation invocation. */
public class TranslationContext {
    private final String threadId;
    private final String runId;
    private final StreamingState streamingState;
    private final ToolState toolState;
    private final PredictiveState predictiveState;
    private final StateProjector stateProjector;
    private final Map<String, Object> accumulatedPredictState = new LinkedHashMap<>();
    private final Set<String> outputSchemaAgentNames;
    private boolean terminal;
    private int generatedReasoningCount;
    private String openReasoningId;
    private String openReasoningText = "";
    private final Set<String> emittedToolCallIds = new HashSet<>();
    private final Set<String> emittedToolResultIds = new HashSet<>();

    /** P0 #3 Mode-A streaming function-call arguments ({@code _translate_streaming_function_call}). */
    private boolean streamingFcArgsEnabled;
    private String activeStreamingFcId;
    private String activeStreamingFcName;
    private final List<String> streamingFcOpenPaths = new ArrayList<>();
    private final Set<String> streamingFcStartedPaths = new HashSet<>();
    private final Set<String> completedStreamingFcNames = new HashSet<>();
    private String lastCompletedStreamingFcName;
    private String lastCompletedStreamingFcId;
    private final Map<String, String> confirmedToStreamingId = new HashMap<>();
    private final Map<String, ToolCallView> pendingProviderCalls = new LinkedHashMap<>();
    private final Map<String, ToolCallView> pendingMissingCalls = new LinkedHashMap<>();
    private final List<List<ToolCallView>> pendingPartialCallBatches = new ArrayList<>();
    private List<ToolCallView> currentPartialCallBatch;
    private final Map<String, Deque<String>> missingResultIdsByName = new HashMap<>();
    private final Set<String> settledPartialCallIds = new HashSet<>();
    private final Map<String, FunctionResponse> deferredPartialResults = new HashMap<>();
    private Set<String> frontendToolNames = Set.of();
    private PendingCallScope frontendScope;
    private String frontendInvocationId;
    private PendingToolCallEmitter pendingToolCallEmitter;
    private int generatedToolCallCount;

    /**
     * Creates a context with predictive-state mappings.
     *
     * @param threadId AG-UI thread identifier
     * @param runId AG-UI run identifier
     * @param predictStateConfig predictive-state mappings
     */
    public TranslationContext(String threadId, String runId, List<PredictStateMapping> predictStateConfig) {
        this(threadId, runId, predictStateConfig, Set.of());
    }

    /**
     * Creates a context with predictive-state mappings and output_schema agent names.
     *
     * <p>Text authored by any agent in {@code outputSchemaAgentNames} is suppressed from the
     * chat UI: it is structured inter-agent output, not user-visible content (GitHub #1390).
     *
     * @param threadId AG-UI thread identifier
     * @param runId AG-UI run identifier
     * @param predictStateConfig predictive-state mappings
     * @param outputSchemaAgentNames agent names whose text is suppressed
     */
    public TranslationContext(String threadId, String runId, List<PredictStateMapping> predictStateConfig,
                              Set<String> outputSchemaAgentNames) {
        this.threadId = threadId;
        this.runId = runId;
        streamingState = new StreamingState();
        toolState = new ToolState();
        predictiveState = new PredictiveState(predictStateConfig);
        stateProjector = new StateProjector(Map.of());
        this.outputSchemaAgentNames = Set.copyOf(outputSchemaAgentNames);
    }

    /**
     * Creates a context without predictive-state mappings.
     *
     * @param threadId AG-UI thread identifier
     * @param runId AG-UI run identifier
     */
    public TranslationContext(String threadId, String runId) {
        this(threadId, runId, List.of());
    }

    /**
     * Returns the AG-UI thread identifier for this translation.
     *
     * @return AG-UI thread identifier
     */
    public String getThreadId() { return threadId; }

    /**
     * Returns the AG-UI run identifier for this translation.
     *
     * @return AG-UI run identifier
     */
    public String getRunId() { return runId; }

    /**
     * Whether text authored by the given agent should be suppressed from the chat UI.
     *
     * @param author source agent name
     * @return true when the author is an output_schema agent whose text is suppressed
     */
    public boolean isOutputSchemaAgent(String author) {
        return author != null && outputSchemaAgentNames.contains(author);
    }
    public boolean isStreaming() { return streamingState.isStreaming(); }
    public Optional<String> getStreamingMessageId() { return streamingState.getMessageId(); }
    public String getCurrentStreamingText() { return streamingState.getCurrentText(); }

    /**
     * Closes the current text lifecycle, if one is open.
     *
     * @return open text message identifier, when present
     */
    public Optional<String> forceCloseStreamingMessage() {
        return getStreamingMessageId().map(messageId -> {
            streamingState.endStream(runId);
            return messageId;
        });
    }

    /**
     * Drops an empty or aggregate-final text payload only at its active stream boundary.
     *
     * @param combinedText complete model text payload
     * @return text to emit, when it is not the active-stream aggregate
     */
    public Optional<String> handleDuplicateOrEmptyStream(String combinedText) {
        if (isDuplicateStream(combinedText) || combinedText.isEmpty()) {
            resetStreamingHistory();
            return Optional.empty();
        }
        return Optional.of(combinedText);
    }

    /**
     * Determines whether a final aggregate duplicates the active text stream exactly.
     *
     * @param combinedText complete model text payload
     * @return whether the payload duplicates the active text stream
     */
    public boolean isDuplicateStream(String combinedText) {
        String lastStreamed = streamingState.getLastStreamedText();
        // Exact match handles normal delta streaming (accumulated text equals the final
        // consolidated message); suffix match handles LLMs that send the accumulated text in
        // every chunk, where last_streamed_text is the concatenation ending with the final text
        // (GitHub #400, mirroring Python _translate_text_content).
        return runId.equals(streamingState.getLastStreamedRunId())
                && lastStreamed != null
                && (combinedText.equals(lastStreamed) || lastStreamed.endsWith(combinedText));
    }

    public void resetStreamingHistory() { streamingState.resetHistory(); }

    /**
     * Resets all translation state so this translator can be reused for a new run (Python
     * {@code EventTranslator.reset}): streaming, tool calls, long-running ids, predictive-state
     * and confirm emission, signatures, deferred confirms, reasoning and streaming function-call
     * arguments are all cleared, and a previously-marked terminal boundary is reopened.
     */
    public void reset() {
        streamingState.reset();
        toolState.reset();
        predictiveState.reset();
        accumulatedPredictState.clear();
        emittedSignatureToolCallIds.clear();
        emittedToolCallIds.clear();
        emittedToolResultIds.clear();
        lroEmittedIdsByName.clear();
        pendingLroIdRemap.clear();
        terminal = false;
        openReasoningId = null;
        openReasoningText = "";
        generatedReasoningCount = 0;
        generatedToolCallCount = 0;
        resetStreamingFc();
    }
    public void endStream() { streamingState.endStream(runId); }
    public void startTrackingToolCall(String toolCallId) { toolState.startTrackingToolCall(toolCallId); }
    public void endTrackingToolCall(String toolCallId) { toolState.endTrackingToolCall(toolCallId); }
    public void addPredictiveStateToolCallId(String toolCallId) { toolState.addPredictiveStateToolCallId(toolCallId); }
    public void populateLongRunningToolIds(Set<String> ids) { toolState.populateLongRunningToolIds(ids); }
    public boolean isLongRunningTool(String toolCallId) { return toolState.isLongRunningTool(toolCallId); }
    public boolean longRunningToolIdsPresent() { return toolState.longRunningToolIdsPresent(); }
    public boolean isLongRunningCallReplay(String name, int position) { return toolState.isLongRunningCallReplay(name, position); }
    /**
     * Records an emitted long-running call for replay deduplication and final-ID matching.
     *
     * @param name tool name
     * @param id client-visible provider identifier
     */
    public void recordLongRunningEmitted(String name, String id) {
        toolState.recordLongRunningEmitted(name, id);
        if (name != null && id != null) {
            lroEmittedIdsByName.computeIfAbsent(name, ignored -> new java.util.ArrayList<>()).add(id);
        }
    }

    /**
     * Captures client-facing to persisted LRO identifiers from the final provider event.
     *
     * @param event persisted non-partial provider event
     */
    public void capturePersistedLroIds(com.google.adk.events.Event event) {
        java.util.Map<String, Integer> consumed = new java.util.HashMap<>();
        event.content().flatMap(com.google.genai.types.Content::parts).orElse(java.util.List.of())
                .forEach(part -> part.functionCall().ifPresent(call -> {
                    String name = call.name().orElse(null);
                    String persistedId = call.id().orElse(null);
                    if (name == null || persistedId == null) {
                        return;
                    }
                    int index = consumed.merge(name, 1, Integer::sum) - 1;
                    java.util.List<String> emitted = lroEmittedIdsByName.getOrDefault(name, java.util.List.of());
                    if (index < emitted.size() && !emitted.get(index).equals(persistedId)) {
                        pendingLroIdRemap.put(emitted.get(index), persistedId);
                    }
                }));
    }

    /**
     * Returns and clears LRO identifier remaps captured after provider persistence.
     *
     * @return captured client-to-persisted identifiers
     */
    public java.util.Map<String, String> drainLroIdRemap() {
        java.util.Map<String, String> result = java.util.Map.copyOf(pendingLroIdRemap);
        pendingLroIdRemap.clear();
        return result;
    }

    public boolean isPredictiveStateTool(String toolCallId) { return toolState.isPredictiveStateTool(toolCallId); }
    private final java.util.Map<String, java.util.List<String>> lroEmittedIdsByName = new java.util.LinkedHashMap<>();
    private final java.util.Map<String, String> pendingLroIdRemap = new java.util.LinkedHashMap<>();
    private final java.util.Set<String> emittedSignatureToolCallIds = new java.util.HashSet<>();
    public boolean hasEmittedSignatureForToolCall(String toolCallId) { return emittedSignatureToolCallIds.contains(toolCallId); }
    public void markSignatureAsEmittedForToolCall(String toolCallId) { emittedSignatureToolCallIds.add(toolCallId); }
    public void addDeferredConfirmEvents(List<com.agui.community.core.event.Event> events) { toolState.addDeferredConfirmEvents(events); }
    public boolean hasDeferredConfirmEvents() { return toolState.hasDeferredConfirmEvents(); }
    public List<com.agui.community.core.event.Event> getAndClearDeferredConfirmEvents() { return toolState.getAndClearDeferredEvents(); }
    public boolean lacksPredictiveStateForTool(String toolName) { return !predictiveState.hasToolConfig(toolName); }
    public boolean hasEmittedPredictiveStateForTool(String toolName) { return predictiveState.hasEmittedForTool(toolName); }
    public void markPredictiveStateAsEmittedForTool(String toolName) { predictiveState.markAsEmittedForTool(toolName); }
    public List<PredictStateMapping> getPredictiveStateMappingsForTool(String toolName) { return predictiveState.getMappingsForTool(toolName); }
    public boolean shouldEmitConfirmForTool(String toolName) { return predictiveState.shouldEmitConfirmForTool(toolName); }
    public boolean hasEmittedConfirmForTool(String toolName) { return predictiveState.hasEmittedConfirmForTool(toolName); }
    public void markConfirmAsEmittedForTool(String toolName) { predictiveState.markAsEmittedConfirmForTool(toolName); }
    public Optional<String> startStreamingIfNeeded() { return streamingState.startStreaming(); }
    public void appendToCurrentStreamText(String text) { streamingState.appendToCurrentText(text); }
    public boolean isActive(String toolCallId) { return toolState.isActive(toolCallId); }
    public boolean isTerminal() { return terminal; }
    public void markTerminal() { terminal = true; }

    /**
     * Resolves the identity for one reasoning message lifecycle.
     *
     * <p>Provider event ids identify transport chunks, not reasoning messages. Once reasoning is
     * open, every later partial/signature/final chunk stays attached to that original entity until
     * an explicit reasoning-end path closes it.
     *
     * @param providerId provider event identifier, if present
     * @return canonical reasoning identifier
     */
    public String reasoningId(String providerId) {
        if (openReasoningId != null) {
            return openReasoningId;
        }
        if (providerId != null && !providerId.isBlank()) {
            return providerId;
        }
        return runId + ":reasoning:" + ++generatedReasoningCount;
    }

    /**
     * Opens the identified reasoning lifecycle and records its first lifecycle state.
     *
     * @param id canonical reasoning identifier
     */
    public void openReasoning(String id) {
        openReasoningId = id;
        openReasoningText = "";
    }

    /**
     * Returns whether the supplied reasoning lifecycle is active.
     *
     * @param id canonical reasoning identifier
     * @return whether the lifecycle is currently open
     */
    public boolean hasOpenReasoning(String id) { return id.equals(openReasoningId); }

    /**
     * Returns a non-duplicate reasoning suffix while retaining the aggregate provider view.
     *
     * @param text provider thought text
     * @return visible suffix when the provider view adds content
     */
    public Optional<String> appendReasoning(String text) {
        String delta = text.startsWith(openReasoningText) ? text.substring(openReasoningText.length()) : text;
        if (text.startsWith(openReasoningText)) {
            openReasoningText = text;
        } else {
            openReasoningText += text;
        }
        return delta.isEmpty() ? Optional.empty() : Optional.of(delta);
    }

    /**
     * Closes the current reasoning lifecycle, if present.
     *
     * @return closed reasoning identifier when one was active
     */
    public Optional<String> forceCloseReasoning() {
        if (openReasoningId == null) {
            return Optional.empty();
        }
        String id = openReasoningId;
        openReasoningId = null;
        openReasoningText = "";
        return Optional.of(id);
    }

    /**
     * Seeds the canonical projection with the accumulated session state this run starts from, so
     * the end-of-run {@code STATE_SNAPSHOT} carries the whole session state and not only this
     * run's deltas (Python builds the snapshot from {@code SessionManager.get_session_state}).
     *
     * <p>Must be called before any event is translated: this run's deltas are applied on top and
     * therefore overwrite the seeded values. Bridge-internal ({@code _ag_ui_}) and ephemeral
     * ({@code temp:}) keys are dropped by the projector.
     *
     * @param sessionState accumulated ADK session state, may be null or empty
     */
    public void seedSessionState(Map<String, Object> sessionState) {
        if (sessionState != null && !sessionState.isEmpty()) {
            stateProjector.apply(sessionState);
        }
    }

    public void applyStateDelta(Map<String, Object> delta) { stateProjector.apply(delta); }

    /**
     * Applies a predictive tool-state mapping to the canonical state projection.
     *
     * @param overlay client-visible predictive state
     */
    public void applyPredictiveState(Map<String, Object> overlay) {
        if (overlay != null) {
            accumulatedPredictState.putAll(overlay);
        }
        stateProjector.apply(Map.of(), overlay);
    }

    /**
     * Accumulates a predict-state value derived from tool-call arguments, keyed by its state key
     * (port of {@code ClientProxyTool} / {@code ClientProxyToolset.get_accumulated_predict_state}).
     * These values are merged into the final {@link #stateSnapshot()} so they survive it.
     *
     * @param stateKey the state key to predict
     * @param value the value derived from the tool argument (or the whole args)
     */
    public void accumulatePredictState(String stateKey, Object value) {
        if (stateKey != null && !stateKey.isEmpty() && value != null) {
            Map<String, Object> overlay = Map.of(stateKey, value);
            accumulatedPredictState.putAll(overlay);
            stateProjector.apply(Map.of(), overlay);
        }
    }

    public Map<String, Object> stateSnapshot() { return stateProjector.snapshot(); }

    /**
     * Replaces the pre-run projection with freshly read session state and reapplies accumulated
     * predictive state on top, matching Python's final-state precedence.
     *
     * @param authoritativeState post-run session state, or an empty map when absent
     * @return canonical client-visible final snapshot
     */
    public Map<String, Object> finalStateSnapshot(Map<String, Object> authoritativeState) {
        return stateProjector.replace(authoritativeState, accumulatedPredictState);
    }

    /**
     * Configures the production frontend persistence boundary for this invocation.
     *
     * @param scope pending-call storage scope
     * @param invocationId current invocation identifier
     * @param names client-executed tool names
     * @param emitter persistence-before-visibility event emitter
     */
    public void configureFrontendToolPersistence(
            PendingCallScope scope,
            String invocationId,
            Set<String> names,
            PendingToolCallEmitter emitter) {
        Set<String> configuredNames = java.util.Objects.requireNonNull(names, "names");
        if (!configuredNames.isEmpty() && emitter == null) {
            throw new IllegalArgumentException("frontend tool persistence requires an emitter");
        }
        frontendScope = scope;
        frontendInvocationId = invocationId;
        frontendToolNames = configuredNames;
        pendingToolCallEmitter = emitter;
    }

    public boolean isFrontendTool(String name) { return frontendToolNames.contains(name); }

    /**
     * Whether production persistence owns native/backend HITL end visibility.
     *
     * @return whether the gate is configured
     */
    public boolean durableHitlEndGateEnabled() { return pendingToolCallEmitter != null; }

    /**
     * Retains a native/backend HITL end at the production durability boundary.
     *
     * @param event native/backend end event
     */
    public void deferDurableHitlEnd(com.agui.community.core.event.ToolCallEndEvent event) {
        if (pendingToolCallEmitter == null) {
            throw new IllegalStateException("HITL end persistence is not configured");
        }
        pendingToolCallEmitter.deferEnd(event);
    }

    /**
     * Persists and then exposes an official frontend chunk.
     *
     * @param call canonical frontend tool call
     * @return persisted visibility event stream
     */
    public Flowable<com.agui.community.core.event.Event> emitFrontendToolCall(ToolCallView call) {
        if (pendingToolCallEmitter == null) {
            throw new IllegalStateException("frontend tool persistence is not configured");
        }
        return pendingToolCallEmitter.emit(frontendScope, frontendInvocationId, call.position(),
                new ToolCallChunkEvent(call.id(), call.name(), call.argsJson()), true);
    }

    /**
     * Persists sibling frontend calls atomically with respect to provider-event visibility.
     *
     * @param calls canonical frontend calls in provider order
     * @return visible chunks after all sibling persistence has settled
     */
    public Flowable<com.agui.community.core.event.Event> emitFrontendToolCalls(List<ToolCallView> calls) {
        if (calls.size() == 1) {
            ToolCallView call = calls.getFirst();
            return markToolCallEmitted(call) ? emitFrontendToolCall(call) : Flowable.empty();
        }
        List<ToolCallView> unexposed = calls.stream().filter(call -> !emittedToolCallIds.contains(call.id())).toList();
        if (unexposed.isEmpty()) {
            return Flowable.empty();
        }
        unexposed.forEach(this::markToolCallEmitted);
        return pendingToolCallEmitter.emitAll(frontendScope, frontendInvocationId, unexposed.stream()
                .map(call -> new PendingToolCallEmitter.PositionedToolCall(call.position(),
                        new ToolCallChunkEvent(call.id(), call.name(), call.argsJson())))
                .toList());
    }

    /**
     * Records a provider call view and returns it only when it is canonical and ready to expose.
     *
     * @param providerId provider function-call identifier, if present
     * @param name tool name
     * @param position ordinal within the provider event
     * @param partial whether the view is partial
     * @param argsJson canonical arguments JSON
     * @return canonical call view when ready to expose
     */
    public Optional<ToolCallView> acceptToolCall(
            String providerId, String name, int position, boolean partial, String argsJson) {
        if (providerId != null && !providerId.isBlank()) {
            ToolCallView view = new ToolCallView(providerId, name, position, argsJson, true);
            if (partial) {
                replaceOrAppendPartial(pendingProviderCalls.put(providerId, view), view);
                return Optional.empty();
            }
            ToolCallView existing = pendingProviderCalls.get(providerId);
            if (existing != null) {
                pendingProviderCalls.put(providerId, view);
                replaceOrAppendPartial(existing, view);
                settledPartialCallIds.add(view.id());
                return Optional.empty();
            }
            return emittedToolCallIds.contains(providerId) ? Optional.empty() : Optional.of(view);
        }
        String key = missingKey(position, name);
        if (partial) {
            ToolCallView existing = pendingMissingCalls.get(key);
            ToolCallView view = new ToolCallView(existing == null ? nextGeneratedToolCallId() : existing.id(),
                    name, position, argsJson, false);
            pendingMissingCalls.put(key, view);
            replaceOrAppendPartial(existing, view);
            return Optional.empty();
        }
        ToolCallView existing = pendingMissingCalls.get(key);
        if (existing != null) {
            ToolCallView view = new ToolCallView(existing.id(), name, position, argsJson, false);
            pendingMissingCalls.put(key, view);
            replaceOrAppendPartial(existing, view);
            settledPartialCallIds.add(view.id());
            return Optional.empty();
        }
        return Optional.of(new ToolCallView(nextGeneratedToolCallId(), name, position, argsJson, false));
    }

    /** Starts the retained batch for one partial provider event. */
    public void beginPartialToolCallBatch() {
        currentPartialCallBatch = new ArrayList<>();
        pendingPartialCallBatches.add(currentPartialCallBatch);
    }

    /**
     * Returns uncompleted partial tool views grouped by original provider event after normal completion.
     *
     * @return provider-event batches awaiting exposure in arrival order
     */
    public List<List<ToolCallView>> drainPartialToolCallBatches() {
        List<List<ToolCallView>> batches = pendingPartialCallBatches.stream()
                .filter(batch -> !batch.isEmpty()).map(List::copyOf).toList();
        pendingPartialCallBatches.clear();
        currentPartialCallBatch = null;
        pendingProviderCalls.clear();
        pendingMissingCalls.clear();
        return batches;
    }

    /**
     * Drains all remaining partial batches on normal upstream completion, making their latest views canonical.
     *
     * @return original batches with any buffered backend results
     */
    public List<SettledPartialBatch> flushPartialToolCallBatches() {
        pendingPartialCallBatches.forEach(batch -> batch.forEach(call -> settledPartialCallIds.add(call.id())));
        return drainSettledPartialToolCallBatches();
    }

    /**
     * Returns uncompleted partial tool views flattened in provider arrival order.
     *
     * @return partial calls awaiting exposure
     */
    public List<ToolCallView> drainPartialToolCalls() {
        return drainPartialToolCallBatches().stream().flatMap(List::stream).toList();
    }

    /**
     * Removes the original partial provider-event batch containing a result-correlated call.
     *
     * @param providerId provider response identifier, if present
     * @param name provider response tool name
     * @return original provider-event batch whose preflight must precede the result
     */
    /**
     * Defers a result until its original provider-event batch is canonical.
     *
     * @param providerId provider response identifier, if present
     * @param name provider response tool name
     * @param response provider response to emit after its batch settles
     * @return whether the response matched a retained partial call
     */
    public boolean deferPartialToolResult(String providerId, String name, FunctionResponse response) {
        ToolCallView correlated = providerId != null && !providerId.isBlank()
                ? pendingProviderCalls.get(providerId) : pendingMissingCalls.values().stream()
                        .filter(call -> call.name().equals(name))
                        .filter(call -> !deferredPartialResults.containsKey(call.id()))
                        .findFirst().orElse(null);
        if (correlated == null) {
            return false;
        }
        settledPartialCallIds.add(correlated.id());
        deferredPartialResults.putIfAbsent(correlated.id(), response);
        return true;
    }

    /**
     * Drains retained batches only once every member has a final view or result.
     *
     * @return settled original provider-event batches in arrival order
     */
    public List<SettledPartialBatch> drainSettledPartialToolCallBatches() {
        List<SettledPartialBatch> settled = new ArrayList<>();
        java.util.Iterator<List<ToolCallView>> batches = pendingPartialCallBatches.iterator();
        while (batches.hasNext()) {
            List<ToolCallView> batch = batches.next();
            if (!batch.isEmpty() && batch.stream().allMatch(call -> settledPartialCallIds.contains(call.id()))) {
                List<ToolCallView> calls = List.copyOf(batch);
                List<FunctionResponse> responses = calls.stream().map(call -> deferredPartialResults.remove(call.id()))
                        .filter(java.util.Objects::nonNull).toList();
                batches.remove();
                pendingProviderCalls.values().removeIf(calls::contains);
                pendingMissingCalls.values().removeIf(calls::contains);
                calls.forEach(call -> settledPartialCallIds.remove(call.id()));
                settled.add(new SettledPartialBatch(calls, responses));
            }
        }
        return settled;
    }

    /**
     * Marks exactly one call lifecycle visible and queues missing IDs for result correlation.
     *
     * @param call exposed canonical call view
     * @return whether the call has not already been emitted
     */
    public boolean markToolCallEmitted(ToolCallView call) {
        if (!emittedToolCallIds.add(call.id())) {
            return false;
        }
        if (!call.providerId()) {
            missingResultIdsByName.computeIfAbsent(call.name(), ignored -> new ArrayDeque<>()).add(call.id());
        }
        return true;
    }

    // --- P0 #3 Mode-A streaming function-call arguments ---

    /**
     * Whether Mode-A streaming function-call argument translation is enabled.
     *
     * @return true when {@code stream_function_call_arguments} was requested
     */
    public boolean streamingFcArgsEnabled() {
        return streamingFcArgsEnabled;
    }

    /**
     * Enables Mode-A streaming function-call argument translation.
     */
    public void enableStreamingFcArgs() {
        this.streamingFcArgsEnabled = true;
    }

    /**
     * The stable synthetic id for the active streaming function call, or {@code null}.
     *
     * @return active streaming tool-call id
     */
    public String activeStreamingFcId() {
        return activeStreamingFcId;
    }

    /**
     * The tool name of the active streaming function call, or {@code null}.
     *
     * @return active streaming tool-call name
     */
    public String activeStreamingFcName() {
        return activeStreamingFcName;
    }

    /**
     * Begins a streaming function call: allocates a stable synthetic id and resets per-call JSON
     * path tracking. Mirrors the Python first-chunk branch of
     * {@code _translate_streaming_function_call}.
     *
     * @param name tool name
     * @return the stable synthetic tool-call id
     */
    public String beginStreamingFc(String name) {
        this.activeStreamingFcId = java.util.UUID.randomUUID().toString();
        this.activeStreamingFcName = name;
        this.streamingFcOpenPaths.clear();
        this.streamingFcStartedPaths.clear();
        return activeStreamingFcId;
    }

    /**
     * Whether the given JSON path already opened a {@code TOOL_CALL_ARGS} key delta.
     *
     * @param jsonPath partial-arg JSON path
     * @return true when already started
     */
    public boolean isStreamingFcStarted(String jsonPath) {
        return streamingFcStartedPaths.contains(jsonPath);
    }

    /**
     * Records that a JSON path opened a {@code TOOL_CALL_ARGS} key delta.
     *
     * @param jsonPath partial-arg JSON path
     */
    public void markStreamingFcStarted(String jsonPath) {
        streamingFcStartedPaths.add(jsonPath);
        streamingFcOpenPaths.add(jsonPath);
    }

    /**
     * The open JSON paths awaiting a closing quote/brace delta.
     *
     * @return open paths
     */
    public List<String> streamingFcOpenPaths() {
        return List.copyOf(streamingFcOpenPaths);
    }

    /**
     * The just-completed streaming function-call name (the aggregated final call is suppressed).
     *
     * @return last completed streaming name, or {@code null}
     */
    public String lastCompletedStreamingFcName() {
        return lastCompletedStreamingFcName;
    }

    /**
     * Records a completed streaming function call and maps the aggregated confirmed id to the
     * stable synthetic id so results remap to the streaming lifecycle.
     *
     * @param name tool name
     * @param streamingId stable synthetic id
     */
    public void completeStreamingFc(String name, String streamingId) {
        completedStreamingFcNames.add(name);
        this.lastCompletedStreamingFcName = name;
        this.lastCompletedStreamingFcId = streamingId;
    }

    /**
     * Maps the aggregated confirmed function-call id to the stable synthetic streaming id, then
     * clears the completed-streaming marker so the mapping applies exactly once. Mirrors the
     * Python {@code _confirmed_to_streaming_id} remap in {@code translate()} (non-partial path).
     *
     * @param confirmedId aggregated ADK id
     */
    public void remapConfirmedStreamingFc(String confirmedId) {
        if (lastCompletedStreamingFcName != null
                && confirmedId != null && lastCompletedStreamingFcId != null
                && !confirmedToStreamingId.containsKey(confirmedId)) {
            confirmedToStreamingId.put(confirmedId, lastCompletedStreamingFcId);
        }
        this.lastCompletedStreamingFcName = null;
        this.lastCompletedStreamingFcId = null;
    }

    /**
     * Resets the active streaming function-call state.
     */
    public void resetStreamingFc() {
        this.activeStreamingFcId = null;
        this.activeStreamingFcName = null;
        this.streamingFcOpenPaths.clear();
        this.streamingFcStartedPaths.clear();
    }

    /**
     * The stable synthetic id for a confirmed (aggregated) function-call id, when it was streamed.
     *
     * @param confirmedId aggregated ADK id
     * @return the streaming id, or {@code null}
     */
    public String streamingIdForConfirmed(String confirmedId) {
        return confirmedToStreamingId.get(confirmedId);
    }

    /**
     * Marks a raw tool-call id as emitted (used by the streaming path).
     *
     * @param id tool-call id
     */
    public void noteEmittedToolCallId(String id) {
        emittedToolCallIds.add(id);
    }

    /**
     * Whether the given tool-call id was already emitted.
     *
     * @param id tool-call id
     * @return true when already emitted
     */
    public boolean hasEmittedToolCall(String id) {
        return emittedToolCallIds.contains(id);
    }

    public boolean markToolResultEmitted(String toolCallId) { return emittedToolResultIds.add(toolCallId); }

    /**
     * Resolves a missing provider result against the next same-name emitted call.
     *
     * @param providerId provider response identifier, if present
     * @param name provider response tool name
     * @return correlated call identifier, if known
     */
    public Optional<String> resolveToolResultId(String providerId, String name) {
        if (providerId != null && !providerId.isBlank()) {
            return Optional.of(providerId);
        }
        Deque<String> candidates = missingResultIdsByName.get(name);
        return candidates == null ? Optional.empty() : Optional.ofNullable(candidates.poll());
    }

    /**
     * Replaces a richer view in its original provider-event batch or appends a new member.
     *
     * @param existing currently retained partial view, if any
     * @param replacement newest canonical partial view
     */
    private void replaceOrAppendPartial(ToolCallView existing, ToolCallView replacement) {
        if (existing == null) {
            partialBatch().add(replacement);
            return;
        }
        for (List<ToolCallView> batch : pendingPartialCallBatches) {
            int index = batch.indexOf(existing);
            if (index >= 0) {
                batch.set(index, replacement);
                return;
            }
        }
        partialBatch().add(replacement);
    }

    /**
     * Removes exactly one retained partial member and drops an empty provider-event batch.
     *
     * @param call retained partial member, if any
     */
    private void removePartial(ToolCallView call) {
        if (call == null) {
            return;
        }
        java.util.Iterator<List<ToolCallView>> batches = pendingPartialCallBatches.iterator();
        while (batches.hasNext()) {
            List<ToolCallView> batch = batches.next();
            if (batch.remove(call) && batch.isEmpty()) {
                batches.remove();
                if (batch == currentPartialCallBatch) {
                    currentPartialCallBatch = null;
                }
                return;
            }
        }
    }

    /**
     * Returns the active provider-event batch, allocating one for direct context callers.
     *
     * @return active retained batch
     */
    private List<ToolCallView> partialBatch() {
        if (currentPartialCallBatch == null) {
            beginPartialToolCallBatch();
        }
        return currentPartialCallBatch;
    }

    private String nextGeneratedToolCallId() { return runId + ":tool:" + ++generatedToolCallCount; }
    private static String missingKey(int position, String name) { return position + ":" + name; }

    /** Retained provider-event calls and responses that became safe together. */
    public record SettledPartialBatch(List<ToolCallView> calls, List<FunctionResponse> responses) {
        /**
         * Defensively captures the settled provider-event batch.
         *
         * @param calls canonical calls in provider order
         * @param responses correlated provider responses
         */
        public SettledPartialBatch {
            calls = List.copyOf(calls);
            responses = List.copyOf(responses);
        }
    }

    /** Canonical provider function-call view retained until it is safe to expose. */
    public record ToolCallView(String id, String name, int position, String argsJson, boolean providerId) { }
}
