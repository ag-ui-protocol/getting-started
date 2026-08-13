package com.agui.adk.translator.step;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.google.gson.Gson;
import com.agui.adk.serialization.ToolCallSerialization;
import com.agui.adk.translator.PredictStateMapping;
import com.agui.adk.translator.TranslationContext;
import com.agui.community.core.event.CustomEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import io.reactivex.rxjava3.core.Flowable;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Emits canonical backend lifecycles and persist-before-visible frontend chunks. */
public enum ToolCallTranslationStep implements EventTranslationStep {
    INSTANCE;

    private static final String ENCODING_ERROR_CODE = "ENCODING_ERROR";
    private static final String ENCODING_ERROR_MESSAGE = "Event encoding failed";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Gson gson = new Gson();

    @Override
    public Flowable<com.agui.community.core.event.Event> translate(Event event, TranslationContext context) {
        return translateCalls(event, context, null);
    }

    /**
     * Translates only the long-running function calls of an ADK event (Python
     * {@code EventTranslator.translate_lro_function_calls}): regular calls in the same event are
     * ignored and the long-running dedup/replay guards still apply.
     *
     * @param event ADK event carrying function-call parts
     * @param context translation state
     * @return TOOL_CALL_START / ARGS / END events for the long-running calls only
     */
    public Flowable<com.agui.community.core.event.Event> translateLroFunctionCalls(
            Event event, TranslationContext context) {
        return translateCalls(event, context, call -> call.id()
                .map(context::isLongRunningTool).orElse(false));
    }

    /**
     * Translates the function-call parts of an ADK event, optionally restricted to a subset
     * (the full {@link #translate} passes {@code null}; the LRO-only public mode passes a
     * long-running predicate).
     *
     * @param event ADK event carrying function-call parts
     * @param context translation state
     * @param include call filter, or {@code null} to translate every call
     * @return translated tool-call lifecycle events
     */
    private Flowable<com.agui.community.core.event.Event> translateCalls(
            Event event, TranslationContext context, java.util.function.Predicate<FunctionCall> include) {
        List<FunctionCall> calls = event.content().flatMap(Content::parts)
                .map(parts -> parts.stream().map(Part::functionCall)
                        .filter(java.util.Optional::isPresent).map(java.util.Optional::get).toList())
                .orElse(List.of());
        if (include != null) {
            calls = calls.stream().filter(include).toList();
        }
        calls = calls.stream()
                .filter(call -> call.name().filter("adk_request_confirmation"::equals).isEmpty())
                .toList();
        if (calls.isEmpty()) {
            return Flowable.empty();
        }
        boolean partial = event.partial().orElse(false);
        // P0 #3 Mode-A streaming function-call arguments (Python `_translate_streaming_function_call`):
        // when enabled, partial events carrying streaming chunks are translated to incremental
        // TOOL_CALL_START / ARGS / END instead of the persist-before-visible frontend lifecycle.
        // The LRO-only mode never routes partial chunks through the streaming-FC lifecycle.
        boolean modeAChunk = context.activeStreamingFcId() != null || calls.stream().anyMatch(call ->
                call.willContinue().isPresent() || call.partialArgs().filter(args -> !args.isEmpty()).isPresent());
        if (include == null && context.streamingFcArgsEnabled() && partial && modeAChunk) {
            return streamingFunctionCalls(calls, context);
        }
        Flowable<com.agui.community.core.event.Event> close = context.forceCloseStreamingMessage()
                .<com.agui.community.core.event.Event>map(TextMessageEndEvent::new)
                .map(Flowable::just).orElse(Flowable.empty());
        if (hasConflictingExplicitProviderIds(calls)) {
            return close.concatWith(Flowable.just(new com.agui.community.core.event.RunErrorEvent(ENCODING_ERROR_MESSAGE, ENCODING_ERROR_CODE, null, null)));
        }
        if (partial && include == null) {
            context.beginPartialToolCallBatch();
        }
        List<TranslationContext.ToolCallView> ready = new java.util.ArrayList<>();
        java.util.Map<String, Integer> longRunningSeenInEvent = new java.util.HashMap<>();
        boolean anyLongRunning = context.longRunningToolIdsPresent();
        for (int position = 0; position < calls.size(); position++) {
            FunctionCall call = calls.get(position);
            String name = call.name().orElseThrow(() -> new IllegalArgumentException("Function call name is empty"));
            String id = call.id().orElse(null);
            // Suppress the aggregated complete call for a just-streamed function call and remap
            // its id to the stable streaming id so the result resolves to the streaming lifecycle
            // (Python translate() `_last_completed_streaming_fc_name` / `_confirmed_to_streaming_id`).
            if (!partial && name.equals(context.lastCompletedStreamingFcName())) {
                context.remapConfirmedStreamingFc(id);
                continue;
            }
            // Positional high-water-mark dedup for long-running calls (Python
            // translate_lro_function_calls, GitHub #1168): SSE re-delivers the same
            // logical LRO call under a different ID, so the ID guard cannot see the
            // duplicate. The Nth same-name LRO call in this event is a replay if we
            // already emitted >= N calls for that name this run. Genuinely parallel
            // same-name calls arrive as one event and exceed the mark, so they emit.
            boolean longRunning = anyLongRunning && id != null && context.isLongRunningTool(id);
            if (longRunning) {
                int lroPosition = longRunningSeenInEvent.merge(name, 1, Integer::sum);
                if (context.isLongRunningCallReplay(name, lroPosition)) {
                    continue;
                }
            }
            TranslationContext.ToolCallView accepted = include != null && longRunning
                    ? new TranslationContext.ToolCallView(id, name, position,
                            ToolCallSerialization.serializeToolArgs(call.args().orElse(Map.of())), true)
                    : context.acceptToolCall(id, name, position, partial,
                            ToolCallSerialization.serializeToolArgs(call.args().orElse(Map.of()))).orElse(null);
            if (accepted != null) {
                if (longRunning) {
                    context.recordLongRunningEmitted(name, id);
                }
                ready.add(accepted);
            }
        }
        Flowable<com.agui.community.core.event.Event> settled = include == null
                ? ToolResultTranslationStep.INSTANCE.emitSettledBatches(
                        context.drainSettledPartialToolCallBatches(), context)
                : Flowable.empty();
        return close.concatWith(emitReadyCalls(ready, context))
                .concatWith(settled)
                .concatWith(functionCallThoughtSignatures(event, context));
    }

    /**
     * Translates a partial ADK event carrying streaming function-call chunks (Mode A, Python
     * {@code _translate_streaming_function_call}) into the incremental AG-UI tool-call lifecycle.
     * Long-running and already-emitted calls are skipped.
     *
     * @param calls streaming function-call parts
     * @param context translation state
     * @return TOOL_CALL_START / ARGS / END events
     */
    private static Flowable<com.agui.community.core.event.Event> streamingFunctionCalls(
            List<FunctionCall> calls, TranslationContext context) {
        List<com.agui.community.core.event.Event> out = new java.util.ArrayList<>();
        for (FunctionCall call : calls) {
            String id = call.id().orElse(null);
            if (id != null && (context.isLongRunningTool(id) || context.hasEmittedToolCall(id))) {
                continue;
            }
            out.addAll(translateStreamingFunctionCall(call, context));
        }
        return Flowable.fromIterable(out);
    }

    /**
     * Translates one streaming function-call chunk, mirroring the state machine in the Python
     * {@code EventTranslator._translate_streaming_function_call}.
     *
     * @param call streaming function-call part
     * @param context translation state
     * @return events for this chunk
     */
    private static List<com.agui.community.core.event.Event> translateStreamingFunctionCall(
            FunctionCall call, TranslationContext context) {
        String toolName = call.name().orElse(null);
        List<com.google.genai.types.PartialArg> partialArgs = call.partialArgs().orElse(List.of());
        Boolean willContinue = call.willContinue().orElse(null);

        // --- First chunk: name + will_continue, no active streaming call ---
        if (toolName != null && Boolean.TRUE.equals(willContinue) && context.activeStreamingFcId() == null) {
            String id = context.beginStreamingFc(toolName);
            List<com.agui.community.core.event.Event> out = new java.util.ArrayList<>();
            // Close any active text message stream before tool calls (Python force_close_streaming_message).
            context.forceCloseStreamingMessage().ifPresent(mid -> out.add(new TextMessageEndEvent(mid)));
            out.add(new ToolCallStartEvent(id, toolName, null, null, null));
            context.noteEmittedToolCallId(id);
            return out;
        }

        // --- No active streaming call: skip stray chunks ---
        if (context.activeStreamingFcId() == null) {
            return List.of();
        }

        String toolCallId = context.activeStreamingFcId();
        List<com.agui.community.core.event.Event> out = new java.util.ArrayList<>();

        // --- Continuation chunks: partial_args as incremental TOOL_CALL_ARGS deltas ---
        if (!partialArgs.isEmpty()) {
            for (com.google.genai.types.PartialArg partialArg : partialArgs) {
                String stringValue = partialArg.stringValue().orElse(null);
                if (stringValue == null) {
                    continue;
                }
                String jsonPath = partialArg.jsonPath().orElse("");
                String delta;
                if (!jsonPath.isEmpty() && !context.isStreamingFcStarted(jsonPath)) {
                    // First occurrence of this JSON path: emit the JSON key prefix.
                    String key = jsonPath.replaceFirst("^[\\.$]+", "");
                    String escapedValue = gson.toJson(stringValue);
                    escapedValue = escapedValue.substring(1, escapedValue.length() - 1);
                    delta = "{" + gson.toJson(key) + ": \"" + escapedValue;
                    context.markStreamingFcStarted(jsonPath);
                } else if (!stringValue.isEmpty()) {
                    // Continuation: just the escaped string fragment.
                    delta = gson.toJson(stringValue);
                    delta = delta.substring(1, delta.length() - 1);
                } else {
                    continue;
                }
                if (!delta.isEmpty()) {
                    out.add(new ToolCallArgsEvent(toolCallId, delta));
                }
            }
            return out;
        }

        // --- End marker: no partial_args and no will_continue ---
        if (!Boolean.TRUE.equals(willContinue)) {
            String resolvedName = context.activeStreamingFcName();
            // Close any open JSON paths with closing quote + brace.
            if (!context.streamingFcOpenPaths().isEmpty()) {
                out.add(new ToolCallArgsEvent(toolCallId, "\"}"));
            }
            // Defer TOOL_CALL_END during streaming FC args when the tool opted into
            // stream_tool_call=True, keeping the call "open" for LRO/HITL flows (Python
            // _streaming_lro_tool_names = {m.tool for m in mappings if m.stream_tool_call}).
            boolean shouldDeferEnd = resolvedName != null
                    && context.getPredictiveStateMappingsForTool(resolvedName).stream()
                            .anyMatch(PredictStateMapping::streamToolCall);
            if (!shouldDeferEnd) {
                out.add(new ToolCallEndEvent(toolCallId));
            }
            if (resolvedName != null) {
                context.completeStreamingFc(resolvedName, toolCallId);
            }
            context.resetStreamingFc();
            return out;
        }
        return out;
    }

    /**
     * Emits a {@link ReasoningEncryptedValueEvent} with {@code subtype="tool-call"} for every
     * function-call part that carries an opaque thought signature, deduplicated per tool-call id.
     *
     * <p>Gemini attaches the encrypted chain-of-thought signature to the function-call part
     * rather than the thought-text part, so the reasoning path never sees it. Mirrors the Python
     * {@code _translate_function_call_signatures} (subtype "tool-call").
     *
     * @param event provider event
     * @param context translation state
     * @return encrypted-value events for unseen signed tool calls
     */
    /**
     * Emits tool-call thought signatures from one provider event.
     *
     * @param event provider event
     * @param context translation state
     * @return signatures for unseen signed tool calls
     */
    private static Flowable<com.agui.community.core.event.Event> functionCallThoughtSignatures(
            Event event, TranslationContext context) {
        java.util.List<com.agui.community.core.event.Event> signatures = new java.util.ArrayList<>();
        for (Part part : event.content().flatMap(Content::parts).orElse(List.of())) {
            if (part.functionCall().isEmpty() || part.thoughtSignature().isEmpty()) {
                continue;
            }
            emitToolCallSignature(part.functionCall().orElseThrow(), part.thoughtSignature().orElseThrow(), context)
                    .ifPresent(signatures::add);
        }
        return Flowable.fromIterable(signatures);
    }

    /**
     * Emits one deduplicated tool-call signature.
     *
     * @param call function call carrying the signature
     * @param signature opaque signature bytes
     * @param context translation state
     * @return encrypted-value event when not already emitted
     */
    private static java.util.Optional<com.agui.community.core.event.Event> emitToolCallSignature(
            FunctionCall call, byte[] signature, TranslationContext context) {
        String id = call.id().orElse(null);
        if (id == null || id.isBlank() || context.hasEmittedSignatureForToolCall(id)) {
            return java.util.Optional.empty();
        }
        context.markSignatureAsEmittedForToolCall(id);
        return java.util.Optional.of(new com.agui.community.core.event.ReasoningEncryptedValueEvent(
                "tool-call", id, java.util.Base64.getEncoder().encodeToString(signature)));
    }

    /**
     * Persists every frontend call in one provider event before exposing any backend lifecycle.
     * Successful calls retain provider ordering; a frontend terminal value suppresses all siblings.
     *
     * @param calls canonical calls ready in provider order
     * @param context translation state
     * @return ordered visible events after frontend persistence settles
     */
    Flowable<com.agui.community.core.event.Event> emitReadyCalls(
            List<TranslationContext.ToolCallView> calls, TranslationContext context) {
        return Flowable.defer(() -> {
            CanonicalCalls canonical = canonicalizeExplicitProviderIds(calls);
            if (canonical.conflicting()) {
                return Flowable.just(new com.agui.community.core.event.RunErrorEvent(ENCODING_ERROR_MESSAGE, ENCODING_ERROR_CODE, null, null));
            }
            List<TranslationContext.ToolCallView> ready = canonical.calls();
            List<TranslationContext.ToolCallView> frontend = ready.stream()
                    .filter(call -> context.isFrontendTool(call.name())).toList();
            return context.emitFrontendToolCalls(frontend).toList().toFlowable().flatMap(frontendEvents -> {
                boolean failed = frontendEvents.stream()
                        .anyMatch(com.agui.community.core.event.RunErrorEvent.class::isInstance);
                if (failed) {
                    return Flowable.fromIterable(frontendEvents);
                }
                java.util.Iterator<com.agui.community.core.event.Event> emittedFrontend = frontendEvents.iterator();
                return Flowable.fromIterable(ready).concatMap(call -> context.isFrontendTool(call.name())
                        ? emittedFrontend.hasNext()
                                ? Flowable.just(emittedFrontend.next()) : Flowable.empty()
                        : emitCanonical(call, context));
            });
        });
    }

    /**
     * Rejects contradictory explicit identities before a partial event can mutate retained state.
     *
     * @param calls provider calls from one event
     * @return whether repeated explicit IDs disagree on canonical identity
     */
    private boolean hasConflictingExplicitProviderIds(List<FunctionCall> calls) {
        Map<String, FunctionCallIdentity> identities = new java.util.HashMap<>();
        for (FunctionCall call : calls) {
            String id = call.id().orElse(null);
            if (id == null || id.isBlank()) {
                continue;
            }
            FunctionCallIdentity identity = new FunctionCallIdentity(
                    call.name().orElseThrow(() -> new IllegalArgumentException("Function call name is empty")),
                    gson.toJson(call.args().orElse(Map.of())));
            FunctionCallIdentity first = identities.putIfAbsent(id, identity);
            if (first != null && !first.equals(identity)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Settles repeated explicit provider identities before the persistence/visibility boundary.
     *
     * @param calls ready canonical calls in provider order
     * @return first-position calls or a conflict indication
     */
    private static CanonicalCalls canonicalizeExplicitProviderIds(List<TranslationContext.ToolCallView> calls) {
        Map<String, TranslationContext.ToolCallView> firstByProviderId = new java.util.LinkedHashMap<>();
        List<TranslationContext.ToolCallView> canonical = new java.util.ArrayList<>();
        for (TranslationContext.ToolCallView call : calls) {
            if (!call.providerId()) {
                canonical.add(call);
                continue;
            }
            TranslationContext.ToolCallView first = firstByProviderId.putIfAbsent(call.id(), call);
            if (first == null) {
                canonical.add(call);
            } else if (!first.name().equals(call.name()) || !first.argsJson().equals(call.argsJson())) {
                return new CanonicalCalls(List.of(), true);
            }
        }
        return new CanonicalCalls(List.copyOf(canonical), false);
    }

    /** Canonical name and arguments of one explicit provider identity. */
    private record FunctionCallIdentity(String name, String argsJson) { }

    /** Provider-event calls after explicit-identity canonicalization. */
    private record CanonicalCalls(List<TranslationContext.ToolCallView> calls, boolean conflicting) { }

    /**
     * Flushes a partial-only canonical view after the upstream has completed normally.
     *
     * @param context translation state
     * @return flushed canonical event stream
     */
    public Flowable<com.agui.community.core.event.Event> flush(TranslationContext context) {
        return ToolResultTranslationStep.INSTANCE.emitSettledBatches(
                context.flushPartialToolCallBatches(), context);
    }

    /**
     * Emits the frontend chunk or complete backend lifecycle for one canonical call.
     *
     * @param call canonical tool-call view
     * @param context translation state
     * @return events for the call
     */
    /**
     * Exposes one canonical call once all required persistence has completed.
     *
     * @param call canonical tool-call view
     * @param context translation state
     * @return frontend chunk or backend lifecycle
     */
    public Flowable<com.agui.community.core.event.Event> emitCanonical(
            TranslationContext.ToolCallView call, TranslationContext context) {
        if (!context.markToolCallEmitted(call)) {
            return Flowable.empty();
        }
        if (context.isFrontendTool(call.name())) {
            return context.emitFrontendToolCall(call);
        }
        context.startTrackingToolCall(call.id());
        Flowable<com.agui.community.core.event.Event> predictive = predictiveEvent(call.name(), call.id(), context, call.argsJson());
        ToolCallEndEvent end = new ToolCallEndEvent(call.id());
        boolean deferredEnd = context.isLongRunningTool(call.id())
                && context.durableHitlEndGateEnabled();
        if (deferredEnd) {
            context.deferDurableHitlEnd(end);
        }
        Flowable<com.agui.community.core.event.Event> lifecycle = Flowable.just(
                        (com.agui.community.core.event.Event) new ToolCallStartEvent(
                                call.id(), call.name(), null, null, null))
                .concatWith("{}".equals(call.argsJson())
                        ? Flowable.empty()
                        : Flowable.just(new ToolCallArgsEvent(call.id(), call.argsJson())))
                .concatWith(deferredEnd ? Flowable.empty() : Flowable.just(end));
        return predictive.concatWith(lifecycle).doFinally(() -> {
            context.endTrackingToolCall(call.id());
            deferConfirmation(call.name(), context);
        });
    }

    /**
     * Builds a predictive-state event for a configured backend tool.
     *
     * @param name tool name
     * @param id canonical tool-call identifier
     * @param context translation state
     * @param argsJson serialized tool-call arguments for the predictive payload
     * @return predictive-state event stream
     */
    private static Flowable<com.agui.community.core.event.Event> predictiveEvent(
            String name, String id, TranslationContext context, String argsJson) {
        if (context.lacksPredictiveStateForTool(name) || context.hasEmittedPredictiveStateForTool(name)) {
            return Flowable.empty();
        }
        context.addPredictiveStateToolCallId(id);
        context.markPredictiveStateAsEmittedForTool(name);
        List<Map<String, Object>> payload = context.getPredictiveStateMappingsForTool(name).stream()
                .map(PredictStateMapping::toPayload).toList();
        payload.forEach(context::applyPredictiveState);
        accumulatePredictState(context.getPredictiveStateMappingsForTool(name), argsJson, context);
        return Flowable.just(new CustomEvent("PredictState", payload, null, payload));
    }

    /**
     * Accumulates predictive state values derived from tool-call arguments into the final
     * STATE_SNAPSHOT (port of {@code ClientProxyTool} / {@code ClientProxyToolset
     * .get_accumulated_predict_state}): for each mapping, the value at {@code tool_argument} in the
     * invoked args (or the whole args when {@code tool_argument} is empty) is captured under
     * {@code state_key}. These survive the final snapshot that would otherwise overwrite state.
     *
     * @param mappings the tool's predict-state mappings
     * @param argsJson the tool-call arguments as JSON
     * @param context translation state
     */
    private static void accumulatePredictState(
            List<PredictStateMapping> mappings, String argsJson, TranslationContext context) {
        if (mappings == null || mappings.isEmpty() || argsJson == null || argsJson.isEmpty()) {
            return;
        }
        Map<String, Object> args = parseArgs(argsJson);
        if (args == null) {
            return;
        }
        for (PredictStateMapping mapping : mappings) {
            String stateKey = mapping.stateKey();
            String toolArgument = mapping.toolArgument();
            if (stateKey == null || stateKey.isEmpty()) {
                continue;
            }
            Object value;
            if (toolArgument != null && !toolArgument.isEmpty()) {
                if (args.containsKey(toolArgument)) {
                    value = args.get(toolArgument);
                } else {
                    continue; // argument absent — no value to accumulate
                }
            } else {
                value = args; // no tool_argument: capture the whole args
            }
            context.accumulatePredictState(stateKey, value);
        }
    }

    /**
     * Parses tool-call arguments JSON into a map, returning {@code null} when unparseable.
     *
     * @param argsJson tool-call arguments JSON
     * @return parsed argument map, or {@code null}
     */
    private static Map<String, Object> parseArgs(String argsJson) {
        try {
            Object parsed = JSON.readValue(argsJson, Object.class);
            if (parsed instanceof Map<?, ?> map) {
                Map<String, Object> out = new LinkedHashMap<>();
                map.forEach((k, v) -> out.put(String.valueOf(k), v));
                return out;
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException ignored) {
            // unparseable args — nothing to accumulate
        }
        return null;
    }

    /**
     * Defers one confirmation lifecycle for a configured backend tool.
     *
     * @param name tool name
     * @param context translation state
     */
    private static void deferConfirmation(String name, TranslationContext context) {
        if (context.lacksPredictiveStateForTool(name)
                || context.hasEmittedConfirmForTool(name)
                || !context.shouldEmitConfirmForTool(name)) {
            return;
        }
        String id = java.util.UUID.randomUUID().toString();
        context.addDeferredConfirmEvents(List.of(
                new ToolCallStartEvent(id, "confirm_changes", null, null, null),
                new ToolCallArgsEvent(id, "{}"), new ToolCallEndEvent(id)));
        context.markConfirmAsEmittedForTool(name);
    }
}
