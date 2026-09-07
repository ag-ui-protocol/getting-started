package com.agui.adk.a2ui;

import com.google.adk.agents.InvocationContext;
import com.google.adk.models.BaseLlm;
import com.google.adk.models.LlmRequest;
import com.google.adk.models.LlmResponse;
import com.google.adk.sessions.Session;
import com.google.adk.tools.BaseTool;
import com.google.adk.tools.ToolContext;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.adk.events.Event;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import io.reactivex.rxjava3.core.Single;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;

/**
 * Live half of the A2UI sub-agent tool (Python {@code A2UISubAgentTool} in {@code a2ui_tool.py}).
 *
 * <p>This class wraps a real ADK {@link BaseLlm} sub-agent (the "model" seam, injected and mocked in
 * tests) and drives the toolkit's validate→retry recovery loop on a worker thread, exactly like the
 * Python {@code run_async}. It owns the ADK glue that {@link A2uiOperations} deliberately keeps
 * out: the per-run {@link #forRun} clone bound to a distinct event queue, the {@code _stream_one_attempt}
 * nested {@code TOOL_CALL_START}/{@code TOOL_CALL_ARGS}/{@code TOOL_CALL_END} emission onto that queue,
 * the forced-{@code render_a2ui} {@link LlmRequest} wrapper ({@link #buildLlmRequest}), and the
 * defensive session-event read ({@link #sessionEvents}).
 *
 * <p>The heavy toolkit assemblers ({@code prepare_a2ui_request}/{@code build_a2ui_envelope}/
 * {@code validate_a2ui_components} from {@code ag-ui-a2ui-toolkit}) are not part of the google-adk
 * dependency set; this port keeps an {@link A2uiValidator} seam (defaulting to a structural check) and
 * minimal prompt/envelope glue so the recovery-loop orchestration is exercisable offline. Per-run
 * {@code instruction} is carried over from the shared config (framework-neutral seam).
 */
public final class A2UISubAgentTool extends BaseTool {

    /** Inner {@code render_a2ui} function call name the sub-agent is forced to call. */
    public static final String RENDER_A2UI_NAME = "render_a2ui";

    /** ADK session-state key under which the AG-UI context list is stored. */
    static final String CONTEXT_STATE_KEY = "_ag_ui_context";

    /** Surface id used when the sub-agent omits {@code surfaceId} on a create. */
    static final String DEFAULT_SURFACE_ID = "dynamic-surface";

    /** Catalog id used when the host supplies none (port of {@code BASIC_CATALOG_ID}). */
    static final String DEFAULT_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";

    /** Default attempt cap (initial try + retries), mirrored from the toolkit. */
    static final int MAX_A2UI_ATTEMPTS = 3;

    /** Error record produced when the sub-agent never calls {@code render_a2ui}. */
    private static final Map<String, String> NO_TOOL_CALL_ERROR = Map.of(
            "code", "empty_components", "path", "components",
            "message", "Sub-agent did not call render_a2ui");

    /**
     * Worker pool that runs the recovery loop off the calling (Rx) thread; daemon threads so the JVM
     * can exit. Python runs each recovery in {@code asyncio.to_thread} (the loop's multi-threaded
     * default executor), so independent runs must never serialize: a cached pool gives every run its
     * own thread while reusing idle ones, instead of a process-global single worker that would
     * head-of-line-block unrelated users/sessions/agents.
     */
    private static final java.util.concurrent.ExecutorService WORKER = java.util.concurrent.Executors
            .newCachedThreadPool(r -> {
                Thread thread = new Thread(r, "a2ui-subagent-tool");
                thread.setDaemon(true);
                return thread;
            });

    /** Per-attempt completion callback (Python {@code on_a2ui_attempt}). */
    @FunctionalInterface
    public interface OnA2uiAttempt {
        /** Observes one recovery attempt record ({@code {attempt, ok, errors}}).
         * @param record the attempt record */
        void accept(Map<String, Object> record);
    }

    /**
     * Validate→retry verdict for one generated attempt.
     *
     * @param valid   whether the attempt passed validation
     * @param errors  structured errors when invalid (empty when valid)
     */
    public record ValidationResult(boolean valid, List<Map<String, String>> errors) {
    }

    /** Structural validation seam (port of {@code validate_a2ui_components} at the loop boundary). */
    @FunctionalInterface
    public interface A2uiValidator {
        /** @param components generated components (may be empty)
         *  @param data generated data model (may be empty)
         *  @param catalog normalized validation catalog (may be null)
         *  @return the validation verdict */
        ValidationResult validate(List<?> components, Map<String, Object> data, Object catalog);
    }

    /**
     * Default validator: the toolkit's semantic validation port (Python
     * {@code validate_a2ui_components}) — refuses a non-list/empty component array, unknown
     * component types (catalog), duplicate/missing ids, unresolved child refs, broken bindings,
     * child cycles and a missing {@code root}, so an invalid generated surface is retried (or the
     * recovery cap is hit) instead of being committed.
     */
    private static final A2uiValidator SEMANTIC_VALIDATOR = (components, data, catalog) -> {
        A2uiComponentsValidator.Verdict verdict = A2uiComponentsValidator.validate(
                components, data, asCatalogDict(catalog));
        return new ValidationResult(verdict.valid(), verdict.errorMaps());
    };

    /**
     * Normalizes a validation-catalog source into the dict the semantic validator reads, or
     * {@code null} for structural-only validation.
     *
     * @param catalog the resolved catalog source (may be null)
     * @return the normalized catalog dict, or {@code null}
     */
    private static Map<String, Object> asCatalogDict(Object catalog) {
        if (catalog instanceof Map<?, ?> dict) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            dict.forEach((k, v) -> normalized.put(String.valueOf(k), v));
            return normalized;
        }
        return null;
    }

    private final BaseLlm model;
    private final Map<String, Object> guidelines;
    private final String defaultSurfaceId;
    private final String defaultCatalogId;
    private final Object catalog;
    private final Map<String, Object> recovery;
    private final OnA2uiAttempt onAttempt;
    private final A2uiValidator validator;
    private volatile BlockingQueue<com.agui.community.core.event.Event> eventQueue;

    /**
     * Creates an A2UI sub-agent tool with the default structural validator.
     *
     * @param toolName         configured tool name (e.g. "generate_a2ui")
     * @param toolDescription  configured tool description
     * @param model            the ADK {@link BaseLlm} sub-agent seam (null in tests to shorten position)
     * @param guidelines       generation/design/composition prompt knobs (may be null)
     * @param defaultSurfaceId fallback surface id (may be null)
     * @param defaultCatalogId fallback catalog id (may be null)
     * @param catalog          host-supplied catalog (may be null)
     * @param recovery         recovery config map (may be null)
     * @param onAttempt        per-attempt observer (may be null)
     */
    public A2UISubAgentTool(String toolName, String toolDescription, BaseLlm model,
                            Map<String, Object> guidelines, String defaultSurfaceId, String defaultCatalogId,
                            Object catalog, Map<String, Object> recovery, OnA2uiAttempt onAttempt) {
        this(toolName, toolDescription, model, guidelines, defaultSurfaceId, defaultCatalogId,
                catalog, recovery, onAttempt, SEMANTIC_VALIDATOR);
    }

    /**
     * Creates an A2UI sub-agent tool with an explicit validator (test seam).
     *
     * @param toolName         configured tool name
     * @param toolDescription  configured tool description
     * @param model            the ADK {@link BaseLlm} sub-agent seam (may be null)
     * @param guidelines       generation/design/composition prompt knobs (may be null)
     * @param defaultSurfaceId fallback surface id (may be null)
     * @param defaultCatalogId fallback catalog id (may be null)
     * @param catalog          host-supplied catalog (may be null)
     * @param recovery         recovery config map (may be null)
     * @param onAttempt        per-attempt observer (may be null)
     * @param validator        validate→retry verdict seam
     */
    A2UISubAgentTool(String toolName, String toolDescription, BaseLlm model,
                     Map<String, Object> guidelines, String defaultSurfaceId, String defaultCatalogId,
                     Object catalog, Map<String, Object> recovery, OnA2uiAttempt onAttempt,
                     A2uiValidator validator) {
        super(toolName, toolDescription);
        this.model = model;
        this.guidelines = guidelines;
        this.defaultSurfaceId = defaultSurfaceId;
        this.defaultCatalogId = defaultCatalogId;
        this.catalog = catalog;
        this.recovery = recovery == null ? Map.of() : recovery;
        this.onAttempt = onAttempt;
        this.validator = validator;
    }

    /**
     * Returns a per-run clone bound to {@code eventQueue} (Python {@code for_run}). The
     * construction-time tool is shared across concurrent runs; the caller swaps in this clone per run so
     * each emits onto its own stream without mutating the shared instance.
     *
     * @param eventQueue the per-run nested tool-call event queue
     * @return a distinct clone sharing the model/config but bound to {@code eventQueue}
     */
    public A2UISubAgentTool forRun(BlockingQueue<com.agui.community.core.event.Event> eventQueue) {
        A2UISubAgentTool clone = new A2UISubAgentTool(name(), description(), model, guidelines,
                defaultSurfaceId, defaultCatalogId, catalog, recovery, onAttempt, validator);
        clone.eventQueue = eventQueue;
        return clone;
    }

    /** Binds this tool to a run event queue (test seam; {@link #forRun} uses it).
     * @param eventQueue the per-run nested tool-call event queue */
    void bindEventQueue(BlockingQueue<com.agui.community.core.event.Event> eventQueue) {
        this.eventQueue = eventQueue;
    }

    /** @return the ADK model seam bound to this tool */
    BaseLlm model() {
        return model;
    }

    /** @return the per-run event queue this tool is bound to (may be null before binding) */
    public BlockingQueue<com.agui.community.core.event.Event> eventQueue() {
        return eventQueue;
    }

    /**
     * ADK {@link BaseTool} contract: executes the A2UI render/update run-loop off the calling thread and
     * completes with the parsed operations envelope (Python {@code run_async}). The toolkit recovery loop
     * runs on a worker thread whose {@code invoke_subagent} callback drives {@link #streamOneAttempt} back
     * into the per-run event queue.
     *
     * @param args        tool arguments ({@code intent}/{@code target_surface_id}/{@code changes})
     * @param toolContext the ADK tool invocation context (session/state access)
     * @return a single completing with the envelope map (or a {@code {"result": string}} fallback)
     */
    @Override
    public Single<Map<String, Object>> runAsync(Map<String, Object> args, ToolContext toolContext) {
        return Single.fromFuture(java.util.concurrent.CompletableFuture.supplyAsync(
                () -> executeRun(args, toolContext), WORKER));
    }

    /**
     * The synchronous run-loop body shared by {@link #runAsync} and tests: reads the session/state,
     * assembles the prompt, and drives the recovery loop through {@link #streamOneAttempt}. Returns the
     * parsed envelope (dict) or a {@code {"result": <string>}} fallback.
     *
     * @param args        tool arguments
     * @param toolContext the ADK tool invocation context
     * @return the tool-return value (envelope map, or a result-wrapped string)
     */
    @SuppressWarnings("unchecked")
    Map<String, Object> executeRun(Map<String, Object> args, ToolContext toolContext) {
        String intent = stringOr(args.get("intent"), "create");
        String targetSurfaceId = stringOrNull(args.get("target_surface_id"));
        String changes = stringOrNull(args.get("changes"));

        List<Event> events = sessionEvents(toolContext);
        // AG-UI messages drive the prior-surface lookup (intent="update"); the genai conversation
        // drives the subagent call. A2UI tool results are normalized to the canonical envelope JSON
        // the toolkit's find_prior_surface expects (Python _normalize_a2ui_tool_results).
        List<com.agui.community.core.message.Message> messages = A2uiOperations.normalizeA2uiToolResults(
                com.agui.adk.history.AdkEventsToMessages.convert(events));
        List<Content> conversation = A2uiOperations.conversationContents(events);
        A2uiOperations.AgUiState stateView = stateViewFrom(toolContext);
        Map<String, Object> state = toAgUiState(stateView);

        // Single catalog, client-sourced (no drift): prefer a host-supplied catalog, else the
        // middleware-injected schema. Python truthiness (`self._catalog or schema_value`): an empty
        // configured catalog must NOT shadow a live schema. Same source feeds render AND validation.
        Object catalogSource = A2uiOperations.truthy(catalog) ? catalog : stateView.schemaValue();
        A2uiOperations.applyRenderedCatalog(state, catalogSource, defaultCatalogId);

        A2uiPromptBuilder.Prepared prepared = A2uiPromptBuilder.prepare(
                intent, targetSurfaceId, changes, messages, state, guidelines);
        if (prepared.error() != null) {
            return asToolReturnMap(A2uiEnvelope.error(prepared.error()));
        }

        String toolCallId = "a2ui-render-" + UUID.randomUUID().toString().substring(0, 8);
        Map<String, Object> result = runRecoveryLoop(prepared.prompt(), toolCallId, conversation,
                prepared.isUpdate(), targetSurfaceId, catalogSource, prepared.prior());
        Object envelope = result.get("envelope");
        return asToolReturnMap((String) envelope);
    }

    /**
     * Returns the tool-return map: the parsed envelope dict when the string is a JSON object, else a
     * {@code {"result": string}} wrapper.
     *
     * @param envelope the envelope JSON string
     * @return the parsed dict, or a result-wrapped string
     */
    static Map<String, Object> asToolReturnMap(String envelope) {
        Object parsed = A2uiOperations.asToolReturn(envelope);
        if (parsed instanceof Map<?, ?> dict) {
            return (Map<String, Object>) dict;
        }
        return Map.of("result", parsed);
    }

    /**
     * The toolkit recovery loop (port of {@code run_a2ui_generation_with_recovery}): tries up to the
     * configured cap, augments the prompt with the prior attempt's validation errors, validates via the
     * {@link A2uiValidator} seam, and stops as soon as an attempt validates. Never retries a valid attempt.
     *
     * @param basePrompt     the assembled sub-agent prompt
     * @param toolCallId     stable nested tool-call id reused across attempts
     * @param conversation   the conversational turns forwarded to the sub-agent
     * @param isUpdate       whether this is an update (skips {@code createSurface})
     * @param targetSurfaceId the target surface id (update)
     * @param catalogSource  the resolved catalog source feeding the validator (may be null)
     * @param prior          the reconstructed prior surface for an update (may be null)
     * @return {@code {"envelope", "attempts", "ok"}}
     */
    Map<String, Object> runRecoveryLoop(String basePrompt, String toolCallId, List<Content> conversation,
                                        boolean isUpdate, String targetSurfaceId,
                                        Object catalogSource, Map<String, Object> prior) {
        int maxAttempts = maxAttempts(recovery);
        List<Map<String, Object>> attempts = new ArrayList<>();
        List<Map<String, String>> lastErrors = new ArrayList<>();

        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            String prompt = augmentPromptWithValidationErrors(basePrompt, lastErrors);
            Map<String, Object> args = streamOneAttempt(prompt, attempt, toolCallId, conversation);

            if (args == null) {
                Map<String, Object> record = attemptRecord(attempt, false, List.of(NO_TOOL_CALL_ERROR));
                attempts.add(record);
                fire(record);
                lastErrors = new ArrayList<>(List.of(NO_TOOL_CALL_ERROR));
                continue;
            }

            Object rawComponents = args.get("components");
            List<?> components = rawComponents instanceof List<?> l ? l : List.of();
            Object rawDataModel = args.get("data");
            Map<String, Object> data = rawDataModel instanceof Map<?, ?>
                    ? (Map<String, Object>) rawDataModel : new LinkedHashMap<>();
            ValidationResult vr = validator.validate(components, data, validationCatalog(catalogSource));
            Map<String, Object> record = attemptRecord(attempt, vr.valid(), vr.errors());
            attempts.add(record);
            fire(record);

            if (vr.valid()) {
                String envelope = A2uiEnvelope.build(
                        args, isUpdate, targetSurfaceId, prior,
                        defaultValue(defaultSurfaceId, DEFAULT_SURFACE_ID),
                        defaultValue(defaultCatalogId, DEFAULT_CATALOG_ID));
                return Map.of("envelope", envelope, "attempts", attempts, "ok", true);
            }
            lastErrors = new ArrayList<>(vr.errors());
        }

        return Map.of("envelope", A2uiEnvelope.exhausted(maxAttempts, attempts),
                "attempts", attempts, "ok", false);
    }

    /**
     * Streams one sub-agent attempt (Python {@code _stream_one_attempt}): emits the nested
     * {@code TOOL_CALL_START}/{@code TOOL_CALL_ARGS}/{@code TOOL_CALL_END} events onto the per-run queue,
     * calls the {@link BaseLlm} model (streamed), and returns the coerced {@code render_a2ui} args, or
     * {@code null} when the model never called {@code render_a2ui} with args.
     *
     * @param prompt       the per-attempt prompt (base + validation errors)
     * @param attempt      the 1-based attempt index
     * @param toolCallId   the stable nested tool-call id
     * @param conversation the conversational turns forwarded to the sub-agent
     * @return the generated, coerced args, or {@code null}
     */
    Map<String, Object> streamOneAttempt(String prompt, int attempt, String toolCallId,
                                         List<Content> conversation) {
        queuePut(new ToolCallStartEvent(toolCallId, RENDER_A2UI_NAME));
        LlmRequest request = buildLlmRequest(prompt, conversation);
        Map<String, Object> finalArgs = null;
        if (model != null) {
            Iterator<LlmResponse> responses = model.generateContent(request, true).blockingIterable().iterator();
            while (responses.hasNext()) {
                LlmResponse response = responses.next();
                FunctionCall fc = A2uiOperations.extractRenderFc(response.content().orElse(null));
                if (fc != null && fc.args().isPresent() && fc.args().get() != null) {
                    finalArgs = A2uiOperations.coerceFreeformArgs(new LinkedHashMap<>(fc.args().get()));
                }
            }
        }
        if (finalArgs != null) {
            queuePut(new ToolCallArgsEvent(toolCallId, PythonJson.stringifySpaced(finalArgs)));
        }
        queuePut(new ToolCallEndEvent(toolCallId));
        return finalArgs;
    }

    /**
     * Builds the forced-{@code render_a2ui} {@link LlmRequest} (Python {@code _build_llm_request}): the
     * model id, the conversation (or prompt fallback), and a config forcing function-calling ANY with only
     * {@code render_a2ui} allowed and the prompt as system instruction.
     *
     * @param prompt       the assembled sub-agent prompt
     * @param conversation the conversational turns to forward
     * @return the wrapped {@link LlmRequest}
     */
    LlmRequest buildLlmRequest(String prompt, List<Content> conversation) {
        LlmRequest.Builder builder = LlmRequest.builder()
                .contents(A2uiOperations.subagentContents(prompt, conversation))
                .config(A2uiOperations.renderRequestConfig(prompt, A2uiOperations.renderA2uiFreeformDeclaration()));
        String modelName = model == null ? null : model.model();
        if (modelName != null) {
            builder.model(modelName);
        }
        return builder.build();
    }

    /**
     * The ADK session's event list, accessed defensively across context shapes (Python
     * {@code _session_events}): reads {@code toolContext.invocationContext().session().events()},
     * tolerating any missing link and returning an empty list instead of failing.
     *
     * @param toolContext the ADK tool invocation context
     * @return the session event list, or an empty list when unavailable
     */
    static List<Event> sessionEvents(ToolContext toolContext) {
        if (toolContext == null) {
            return List.of();
        }
        InvocationContext invocation = toolContext.invocationContext();
        Session session = invocation == null ? null : invocation.session();
        List<Event> events = session == null ? null : session.events();
        return events == null ? new ArrayList<>() : new ArrayList<>(events);
    }

    /**
     * Puts one nested tool-call event onto the bound per-run event queue.
     *
     * @param event the AG-UI event to emit
     * @throws IllegalStateException when no queue is bound or the thread is interrupted
     */
    private void queuePut(com.agui.community.core.event.Event event) {
        BlockingQueue<com.agui.community.core.event.Event> queue = eventQueue;
        if (queue == null) {
            throw new IllegalStateException("A2UI sub-agent tool not bound to a run event queue");
        }
        try {
            queue.put(event);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while queuing A2UI tool event", e);
        }
    }

    /**
     * Reads the flat context list off the ADK session state and remaps it (Python {@code _state_view}).
     *
     * @param toolContext the ADK tool invocation context (may be null)
     * @return the remapped {@code ag-ui} state view, empty when the state is unavailable
     */
    @SuppressWarnings("unchecked")
    private static A2uiOperations.AgUiState stateViewFrom(ToolContext toolContext) {
        if (toolContext == null) {
            return new A2uiOperations.AgUiState(List.of(), null, false);
        }
        try {
            Object raw = toolContext.state().get(CONTEXT_STATE_KEY);
            if (!(raw instanceof List<?> list)) {
                return new A2uiOperations.AgUiState(List.of(), null, false);
            }
            List<Map<String, Object>> entries = new ArrayList<>();
            for (Object item : list) {
                if (item instanceof Map<?, ?> mapItem) {
                    entries.add((Map<String, Object>) mapItem);
                }
            }
            return A2uiOperations.stateView(entries);
        } catch (Exception e) {
            return new A2uiOperations.AgUiState(List.of(), null, false);
        }
    }

    /**
     * Rebuilds the {@code {"ag-ui": {context, a2ui_schema?}}} state map for the prompt slot.
     *
     * @param view the remapped state view
     * @return the {@code ag-ui} state map
     */
    private static Map<String, Object> toAgUiState(A2uiOperations.AgUiState view) {
        Map<String, Object> agUi = new LinkedHashMap<>();
        agUi.put("context", view.context());
        if (view.hasSchema()) {
            agUi.put("a2ui_schema", view.schemaValue());
        }
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("ag-ui", agUi);
        return state;
    }

    /**
     * The validation catalog for one run: the same resolved catalog source that feeds rendering is
     * normalized with the default catalog id (Python {@code normalize_catalog_dict(catalog_source)}),
     * so catalog-aware membership/required-prop validation always uses the ACTIVE context catalog
     * rather than only the construction-time one.
     *
     * @param catalogSource the resolved catalog source (may be null)
     * @return the normalized validation catalog, or {@code null} for structural-only validation
     */
    private Object validationCatalog(Object catalogSource) {
        if (catalogSource == null) {
            return null;
        }
        return A2uiCatalogNormalizer.normalizeCatalogDict(
                catalogSource, defaultValue(defaultCatalogId, DEFAULT_CATALOG_ID));
    }

    private static String defaultValue(String value, String fallback) {
        return (value == null || value.isEmpty()) ? fallback : value;
    }

    /** Appends the prior attempt's validation errors as a fix-it block (port of {@code augment_prompt_with_validation_errors}). */
    /**
     * Appends the prior attempt's validation errors as a fix-it block (port of
     * {@code augment_prompt_with_validation_errors}); no-op when there are no errors.
     *
     * @param prompt the base prompt
     * @param errors the prior attempt's validation errors (may be empty)
     * @return the augmented prompt
     */
    private static String augmentPromptWithValidationErrors(String prompt, List<Map<String, String>> errors) {
        if (errors == null || errors.isEmpty()) {
            return prompt;
        }
        StringBuilder sb = new StringBuilder(prompt);
        sb.append("\n\n## Previous attempt was invalid — fix these and regenerate:\n");
        for (Map<String, String> error : errors) {
            sb.append("- [").append(error.get("code")).append("] ").append(error.get("path"))
                    .append(": ").append(error.get("message")).append("\n");
        }
        return sb.toString();
    }

    private static int maxAttempts(Map<String, Object> config) {
        Object value = config.get("maxAttempts");
        return value instanceof Number n ? n.intValue() : MAX_A2UI_ATTEMPTS;
    }

    /**
     * Builds one recovery attempt record ({@code {attempt, ok, errors}}).
     *
     * @param attempt the 1-based attempt index
     * @param ok      whether the attempt validated
     * @param errors  the structured errors for the attempt
     * @return the attempt record
     */
    private static Map<String, Object> attemptRecord(int attempt, boolean ok, List<Map<String, String>> errors) {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("attempt", attempt);
        record.put("ok", ok);
        record.put("errors", errors);
        return record;
    }

    /**
     * Delivers an attempt record to the configured observer, if any.
     *
     * @param record the attempt record
     */
    private void fire(Map<String, Object> record) {
        if (onAttempt != null) {
            onAttempt.accept(record);
        }
    }

    private static String stringOr(Object value, String fallback) {
        return value instanceof String s ? s : fallback;
    }

    private static String stringOrNull(Object value) {
        return value instanceof String s ? s : null;
    }
}
