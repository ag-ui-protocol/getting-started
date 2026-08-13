package com.agui.adk.a2ui;

import com.google.adk.agents.InvocationContext;
import com.google.adk.models.BaseLlm;
import com.google.adk.models.LlmRequest;
import com.google.adk.models.LlmResponse;
import com.google.adk.sessions.Session;
import com.google.adk.sessions.State;
import com.google.adk.tools.ToolContext;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.FunctionCallingConfigMode;
import com.google.genai.types.Part;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import io.reactivex.rxjava3.schedulers.Schedulers;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * P0 #1 (live half) — A2UISubAgentTool orchestration on a mocked ADK runtime (no live LLM).
 * Proves the per-run {@code forRun} clone, the async recovery driver, the nested TOOL_CALL_* emission,
 * the forced LlmRequest wrapper and the defensive session-events read.
 */
class A2UISubAgentToolTest {

    private static Map<String, Object> renderArgs(String id) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("surfaceId", "surface-1");
        args.put("components", List.of(Map.of("id", id, "component", "Text", "text", "Hi")));
        return args;
    }

    private static LlmResponse responseWith(FunctionCall fc) {
        Content content = Content.builder().role("model")
                .parts(List.of(Part.builder().functionCall(fc).build())).build();
        return LlmResponse.builder().content(content).build();
    }

    private static A2UISubAgentTool tool(BaseLlm model, A2UISubAgentTool.A2uiValidator validator,
                                         Map<String, Object> recovery, A2UISubAgentTool.OnA2uiAttempt onAttempt) {
        Map<String, Object> guidelines = Map.of("composition_guide", "design carefully");
        if (validator == null) {
            return new A2UISubAgentTool("generate_a2ui", "generate or update A2UI", model,
                    guidelines, "surface", "catalog", null, recovery, onAttempt);
        }
        return new A2UISubAgentTool("generate_a2ui", "generate or update A2UI", model,
                guidelines, "surface", "catalog", null, recovery, onAttempt, validator);
    }

    @Test
    void forRunClonesBoundToDistinctEventQueues() {
        BaseLlm model = mock(BaseLlm.class);
        A2UISubAgentTool shared = tool(model, null, null, null);
        LinkedBlockingQueue<Event> q1 = new LinkedBlockingQueue<>();
        LinkedBlockingQueue<Event> q2 = new LinkedBlockingQueue<>();

        A2UISubAgentTool first = shared.forRun(q1);
        A2UISubAgentTool second = shared.forRun(q2);

        assertThat(first).isNotSameAs(shared);
        assertThat(second).isNotSameAs(shared);
        assertThat(first).isNotSameAs(second);
        assertThat(first.eventQueue()).isSameAs(q1);
        assertThat(second.eventQueue()).isSameAs(q2);
        assertThat(first.model()).isSameAs(shared.model());
    }

    @Test
    void streamOneAttemptEmitsStartArgsEndAndExtractsRenderFc() {
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall fc = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs("root")).build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(fc)));

        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        A2UISubAgentTool tool = tool(model, null, null, null);
        tool.bindEventQueue(queue);

        Map<String, Object> args = tool.streamOneAttempt("prompt", 1, "call-1", List.of());

        assertThat(args).isNotNull();
        assertThat(args.get("surfaceId")).isEqualTo("surface-1");
        assertThat(args.get("components")).isInstanceOf(Iterable.class);

        List<Event> emitted = drain(queue);
        assertThat(emitted).hasSize(3);
        assertThat(emitted.get(0)).isInstanceOf(ToolCallStartEvent.class);
        assertThat(((ToolCallStartEvent) emitted.get(0)).toolCallId()).isEqualTo("call-1");
        assertThat(((ToolCallStartEvent) emitted.get(0)).toolCallName()).isEqualTo("render_a2ui");
        assertThat(emitted.get(1)).isInstanceOf(ToolCallArgsEvent.class);
        assertThat(((ToolCallArgsEvent) emitted.get(1)).delta()).contains("\"components\"");
        assertThat(emitted.get(2)).isInstanceOf(ToolCallEndEvent.class);
        assertThat(((ToolCallEndEvent) emitted.get(2)).toolCallId()).isEqualTo("call-1");

        verify(model).generateContent(any(LlmRequest.class), eq(true));
    }

    @Test
    void buildLlmRequestForcesAnyModeWithOnlyRenderAllowed() {
        BaseLlm model = mock(BaseLlm.class);
        when(model.model()).thenReturn("gemini-x");
        A2UISubAgentTool tool = tool(model, null, null, null);
        LlmRequest request = tool.buildLlmRequest("the prompt", List.of());

        assertThat(request.model().orElse(null)).isEqualTo("gemini-x");
        assertThat(request.config().isPresent()).isTrue();
        var config = request.config().get();
        assertThat(config.systemInstruction().isPresent()).isTrue();
        var toolConfig = config.toolConfig().get();
        var fcConfig = toolConfig.functionCallingConfig().get();
        assertThat(fcConfig.mode().get().knownEnum()).isEqualTo(FunctionCallingConfigMode.Known.ANY);
        assertThat(fcConfig.allowedFunctionNames().get()).containsExactly("render_a2ui");
        assertThat(config.tools().get()).hasSize(1);
        assertThat(config.tools().get().get(0).functionDeclarations().get().get(0).name().get())
                .isEqualTo("render_a2ui");
        // Empty conversation -> the prompt rides as the defensive user turn.
        assertThat(request.contents()).hasSize(1);
        assertThat(request.contents().get(0).role().orElse(null)).isEqualTo("user");
    }

    @Test
    void runAsyncDrivesRecoveryLoopThroughSubagentInvokeAndReturnsEnvelope() {
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall fc = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs("root")).build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(fc)));

        List<Map<String, Object>> attempts = new ArrayList<>();
        A2UISubAgentTool tool = tool(model, null, null, attempts::add);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        ToolContext context = context();
        Map<String, Object> result = tool.runAsync(args("create", null, null), context).blockingGet();

        assertThat(result).containsKey("a2ui_operations");
        assertThat(attempts).hasSize(1);
        assertThat(attempts.get(0).get("ok")).isEqualTo(true);

        List<Event> emitted = drain(queue);
        assertThat(emitted).hasSize(3);
        verify(model, times(1)).generateContent(any(LlmRequest.class), eq(true));
    }

    @Test
    void recoveryRetriesUntilValidAttemptThenSucceeds() {
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall bad = fc("bad");
        FunctionCall good = fc("good");
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(bad)), Flowable.just(responseWith(good)));

        A2UISubAgentTool.A2uiValidator validator = (components, data, catalog) -> {
            Object first = ((List<?>) components).isEmpty() ? Map.of() : ((List<?>) components).get(0);
            boolean valid = first instanceof Map<?, ?> m && !"bad".equals(m.get("id"));
            return new A2UISubAgentTool.ValidationResult(valid,
                    valid ? List.of() : List.of(Map.of("code", "x", "path", "components", "message", "bad")));
        };
        List<Map<String, Object>> attempts = new ArrayList<>();
        A2UISubAgentTool tool = tool(model, validator, Map.of("maxAttempts", 3), attempts::add);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> result = tool.executeRun(args("create", null, null), context());

        assertThat(result).containsKey("a2ui_operations");
        assertThat(attempts).hasSize(2);
        assertThat(attempts.get(0).get("ok")).isEqualTo(false);
        assertThat(attempts.get(1).get("ok")).isEqualTo(true);
        verify(model, times(2)).generateContent(any(LlmRequest.class), eq(true));
    }

    @Test
    void recoveryExhaustsWhenModelNeverCallsRenderA2ui() {
        BaseLlm model = mock(BaseLlm.class);
        Content textOnly = Content.builder().role("model")
                .parts(List.of(Part.builder().text("no tool call").build())).build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(LlmResponse.builder().content(textOnly).build()));

        List<Map<String, Object>> attempts = new ArrayList<>();
        A2UISubAgentTool tool = tool(model, null, Map.of("maxAttempts", 1), attempts::add);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> result = tool.executeRun(args("create", null, null), context());

        assertThat(result.get("code")).isEqualTo("a2ui_recovery_exhausted");
        assertThat(attempts).hasSize(1);
        assertThat(attempts.get(0).get("ok")).isEqualTo(false);
    }

    @Test
    void sessionEventsAreReadDefensively() {
        ToolContext nullContext = null;
        assertThat(A2UISubAgentTool.sessionEvents(nullContext)).isEmpty();

        ToolContext noInvocation = mock(ToolContext.class);
        assertThat(A2UISubAgentTool.sessionEvents(noInvocation)).isEmpty();

        InvocationContext invocation = mock(InvocationContext.class);
        Session session = mock(Session.class);
        when(noInvocation.invocationContext()).thenReturn(invocation);
        assertThat(A2UISubAgentTool.sessionEvents(noInvocation)).isEmpty(); // null session

        when(invocation.session()).thenReturn(session);
        when(session.events()).thenReturn(List.of(mock(com.google.adk.events.Event.class)));
        assertThat(A2UISubAgentTool.sessionEvents(noInvocation)).hasSize(1);
    }

    // ---------------------------------------------------------------------
    // Cluster a2ui finding tests (C-01, C-02, M-16, M-17, M-24, M-25)
    // ---------------------------------------------------------------------

    @Test
    void defaultSemanticValidatorRetriesAndNeverCommitsInvalidComponents() {
        // C-01: the run-loop's DEFAULT validator is the semantic port of validate_a2ui_components
        // (the audit's earlier test used a custom validator; the default must reject bad payloads).
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall invalid = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(Map.of("surfaceId", "surface-1",
                        "components", List.of(Map.of("id", "root")))) // missing component type
                .build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(invalid)), Flowable.just(responseWith(invalid)));

        List<Map<String, Object>> attempts = new ArrayList<>();
        A2UISubAgentTool tool = tool(model, null, Map.of("maxAttempts", 2), attempts::add);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> result = tool.executeRun(args("create", null, null), context());

        // Never committed: the loop exhausted instead of returning a surface envelope.
        assertThat(result.get("code")).isEqualTo("a2ui_recovery_exhausted");
        assertThat(result).doesNotContainKey("a2ui_operations");
        assertThat(attempts).hasSize(2);
        assertThat(attempts.get(0).get("ok")).isEqualTo(false);
        assertThat(attempts.get(1).get("ok")).isEqualTo(false);
        assertThat(attempts.get(1).get("errors")).isNotNull();
        verify(model, times(2)).generateContent(any(LlmRequest.class), eq(true));
    }

    @Test
    void updateWithoutPriorSurfaceReturnsUnknownSurfaceError() {
        // C-02: no history lookup match -> dedicated "unknown surface" error, model never called.
        BaseLlm model = mock(BaseLlm.class);
        A2UISubAgentTool tool = tool(model, null, null, null);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> result = tool.executeRun(args("update", "ghost-surface", "make it bigger"),
                context());

        assertThat(result).doesNotContainKey("a2ui_operations");
        String error = (String) result.get("error");
        assertThat(error).isNotNull();
        assertThat(error).contains("intent='update' requested target_surface_id='ghost-surface'");
        assertThat(error).contains("no prior render of that surface was found in conversation history");
        verify(model, times(0)).generateContent(any(LlmRequest.class), eq(true));
    }

    @Test
    void updateWithPriorSurfaceCommitsUpdateComponentsOnly() {
        // C-02: with a prior createSurface+updateComponents in history, an update looks the surface
        // up and emits updateComponents (never createSurface) for the TARGET surface id.
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall fc = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs("root")).build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(fc)));

        A2UISubAgentTool tool = tool(model, null, null, null);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> priorEnvelope = Map.of("a2ui_operations", List.of(
                Map.of("version", "v0.9", "createSurface",
                        Map.of("surfaceId", "surface-1", "catalogId", "cat-a")),
                Map.of("version", "v0.9", "updateComponents",
                        Map.of("surfaceId", "surface-1", "components",
                                List.of(Map.of("id", "root", "component", "Text", "text", "v1"))))));
        FunctionResponse fr = FunctionResponse.builder().id("fr1").name("generate_a2ui")
                .response(priorEnvelope).build();
        com.google.adk.events.Event toolEvent = com.google.adk.events.Event.builder()
                .author("tool").partial(false)
                .content(Content.builder().role("tool").parts(List.of(
                        Part.builder().functionResponse(fr).build())).build()).build();

        Map<String, Object> result = tool.executeRun(
                args("update", "surface-1", "change the text"),
                contextWithEvents(List.of(toolEvent)));

        assertThat(result.get("a2ui_operations")).isInstanceOf(Iterable.class);
        List<?> ops = (List<?>) result.get("a2ui_operations");
        assertThat(ops).hasSize(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> op = (Map<String, Object>) ops.get(0);
        assertThat(op).containsKey("updateComponents");
        assertThat(op).doesNotContainKey("createSurface");
        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) op.get("updateComponents");
        assertThat(payload.get("surfaceId")).isEqualTo("surface-1");
    }

    @Test
    void contextSchemaCatalogDrivesSemanticValidation() {
        // M-16: the validator must use the CONTEXT-sourced catalog (not only a construction-time
        // one). With no configured catalog and a live schema, an unknown component type fails.
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall unknown = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(Map.of("surfaceId", "surface-1",
                        "components", List.of(Map.of("id", "root", "component", "Widget", "text", "hi"))))
                .build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(unknown)), Flowable.just(responseWith(unknown)));

        A2UISubAgentTool tool = new A2UISubAgentTool("generate_a2ui", "generate or update A2UI", model,
                Map.of("composition_guide", "design carefully"), "surface", "catalog",
                null, Map.of("maxAttempts", 2), null);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> result = tool.executeRun(args("create", null, null),
                contextWithSchemaCatalog(schemaCatalogJson()));

        // Widget is not in the context catalog -> every attempt invalid -> exhausted, not committed.
        assertThat(result.get("code")).isEqualTo("a2ui_recovery_exhausted");
        assertThat(attemptsErrors(result)).anyMatch(e -> e.contains("'Widget' is not in the catalog"));
    }

    @Test
    void emptyConfiguredCatalogFallsBackToContextSchema() {
        // M-25: Python truthiness — an EMPTY configured catalog must not shadow a live schema
        // (the old Java null-check let "" win and silently lost the catalog).
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall unknown = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(Map.of("surfaceId", "surface-1",
                        "components", List.of(Map.of("id", "root", "component", "Widget", "text", "hi"))))
                .build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(unknown)), Flowable.just(responseWith(unknown)));

        A2UISubAgentTool tool = new A2UISubAgentTool("generate_a2ui", "generate or update A2UI", model,
                Map.of("composition_guide", "design carefully"), "surface", "catalog",
                "", Map.of("maxAttempts", 2), null);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> result = tool.executeRun(args("create", null, null),
                contextWithSchemaCatalog(schemaCatalogJson()));

        assertThat(result.get("code")).isEqualTo("a2ui_recovery_exhausted");
        assertThat(attemptsErrors(result)).anyMatch(e -> e.contains("'Widget' is not in the catalog"));
    }

    @Test
    void nonEmptyConfiguredCatalogWinsOverContextSchema() {
        // M-25 positive side: a truthy configured catalog is used; the context schema is not.
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall valid = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs("root")).build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(responseWith(valid)));

        A2UISubAgentTool tool = new A2UISubAgentTool("generate_a2ui", "generate or update A2UI", model,
                Map.of("composition_guide", "design carefully"), "surface", "catalog",
                "{\"components\": {\"Text\": {\"type\": \"object\", \"required\": [\"text\"]}}}",
                null, null);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> result = tool.executeRun(args("create", null, null),
                contextWithSchemaCatalog(schemaCatalogJson()));

        assertThat(result.get("a2ui_operations")).isNotNull();
    }

    @Test
    void promptIncludesDefaultsContextAndEditBlock() throws Exception {
        // M-17: the sub-agent prompt carries the default generation + design guidelines, the
        // AG-UI context entries, the rendered schema ("Available Components") and the edit block
        // with the previous surface's components/data and requested changes.
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall fc = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs("root")).build();
        java.util.concurrent.atomic.AtomicReference<String> capturedPrompt =
                new java.util.concurrent.atomic.AtomicReference<>();
        when(model.generateContent(any(LlmRequest.class), eq(true))).thenAnswer(inv -> {
            LlmRequest request = inv.getArgument(0);
            capturedPrompt.set(request.config().get().systemInstruction().get()
                    .parts().get().get(0).text().get());
            return Flowable.just(responseWith(fc));
        });

        A2UISubAgentTool tool = tool(model, null, null, null);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);

        Map<String, Object> priorEnvelope = Map.of("a2ui_operations", List.of(
                Map.of("version", "v0.9", "createSurface",
                        Map.of("surfaceId", "surface-1", "catalogId", "cat-a")),
                Map.of("version", "v0.9", "updateComponents",
                        Map.of("surfaceId", "surface-1", "components",
                                List.of(Map.of("id", "root", "component", "Text", "text", "v1"))))));
        FunctionResponse fr = FunctionResponse.builder().id("fr1").name("generate_a2ui")
                .response(priorEnvelope).build();
        com.google.adk.events.Event toolEvent = com.google.adk.events.Event.builder()
                .author("tool").partial(false)
                .content(Content.builder().role("tool").parts(List.of(
                        Part.builder().functionResponse(fr).build())).build()).build();

        Map<String, Object> result = tool.executeRun(
                args("update", "surface-1", "make the text bolder"),
                contextWithEventsAndSchema(List.of(toolEvent), "dark mode"));

        assertThat(result.get("a2ui_operations")).isNotNull();
        String prompt = capturedPrompt.get();
        assertThat(prompt).isNotNull();
        // Defaults (never lost when the guidelines bag omits them).
        assertThat(prompt).contains("Generate A2UI v0.9 JSON.");
        assertThat(prompt).contains("## Design Guidelines");
        // Context entries + rendered schema slot.
        assertThat(prompt).contains("## User preferences");
        assertThat(prompt).contains("dark mode");
        assertThat(prompt).contains("## Available Components");
        // Edit block: previous components + requested changes.
        assertThat(prompt).contains("## Editing an existing surface");
        assertThat(prompt).contains("### Previous components");
        assertThat(prompt).contains("\"text\": \"v1\"");
        assertThat(prompt).contains("### Requested changes");
        assertThat(prompt).contains("make the text bolder");
    }

    @Test
    void overlappingToolsDoNotTerminateSharedDrainBeforeRunProducer() throws Exception {
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall fc = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs("root")).build();
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(2);
        java.util.concurrent.CountDownLatch releaseFirst = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger invocation = new java.util.concurrent.atomic.AtomicInteger();
        when(model.generateContent(any(LlmRequest.class), eq(true))).thenAnswer(inv -> {
            int position = invocation.incrementAndGet();
            entered.countDown();
            if (position == 1) {
                releaseFirst.await();
            }
            return Flowable.just(responseWith(fc));
        });

        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        A2UISubAgentTool shared = tool(model, null, null, null);
        A2UISubAgentTool slow = shared.forRun(queue);
        A2UISubAgentTool fast = shared.forRun(queue);
        TestSubscriber<Event> drain = A2uiQueueDrain.drain(queue)
                .subscribeOn(Schedulers.io()).test();

        java.util.concurrent.CompletableFuture<Map<String, Object>> slowResult =
                java.util.concurrent.CompletableFuture.supplyAsync(() ->
                        slow.runAsync(args("create", null, null), context()).blockingGet());
        while (entered.getCount() == 2) {
            Thread.onSpinWait();
        }
        java.util.concurrent.CompletableFuture<Map<String, Object>> fastResult =
                java.util.concurrent.CompletableFuture.supplyAsync(() ->
                        fast.runAsync(args("create", null, null), context()).blockingGet());

        assertThat(entered.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(fastResult.get(5, java.util.concurrent.TimeUnit.SECONDS).get("a2ui_operations")).isNotNull();
        drain.awaitCount(3);
        drain.assertNotComplete();

        releaseFirst.countDown();
        assertThat(slowResult.get(5, java.util.concurrent.TimeUnit.SECONDS).get("a2ui_operations")).isNotNull();
        drain.awaitCount(6);
        drain.assertNotComplete();

        queue.offer(A2uiQueueDrain.terminal());
        drain.awaitDone(5, java.util.concurrent.TimeUnit.SECONDS);
        drain.assertComplete().assertNoErrors().assertValueCount(6);
        assertThat(drain.values()).allMatch(event -> !(event instanceof ToolCallEndEvent end)
                || !"__a2ui_queue_done__".equals(end.toolCallId()));
    }

    @Test
    void twoConcurrentRunsAreInFlightSimultaneously() throws Exception {
        // M-24: runs must never serialize on one global worker; a cached pool keeps two
        // independent run-loops in flight at once.
        BaseLlm model = mock(BaseLlm.class);
        FunctionCall fc = FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs("root")).build();
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(2);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        when(model.generateContent(any(LlmRequest.class), eq(true))).thenAnswer(inv -> {
            entered.countDown();
            release.await();
            return Flowable.just(responseWith(fc));
        });

        A2UISubAgentTool tool = tool(model, null, null, null);
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        tool.bindEventQueue(queue);
        Map<String, Object> a = args("create", null, null);
        Map<String, Object> b = args("create", null, null);

        java.util.concurrent.CompletableFuture<Map<String, Object>> first =
                java.util.concurrent.CompletableFuture.supplyAsync(() -> tool.runAsync(a, context()).blockingGet());
        java.util.concurrent.CompletableFuture<Map<String, Object>> second =
                java.util.concurrent.CompletableFuture.supplyAsync(() -> tool.runAsync(b, context()).blockingGet());

        try {
            assertThat(entered.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        } finally {
            release.countDown();
        }
        assertThat(first.get(5, java.util.concurrent.TimeUnit.SECONDS).get("a2ui_operations")).isNotNull();
        assertThat(second.get(5, java.util.concurrent.TimeUnit.SECONDS).get("a2ui_operations")).isNotNull();
        verify(model, times(2)).generateContent(any(LlmRequest.class), eq(true));
    }

    // ---------------------------------------------------------------------
    // Helpers for the cluster a2ui finding tests
    // ---------------------------------------------------------------------

    private static String schemaCatalogJson() {
        return "{\"components\": {\"Text\": {\"type\": \"object\", \"required\": [\"text\"]}}}";
    }

    private static List<String> attemptsErrors(Map<String, Object> result) {
        List<String> out = new ArrayList<>();
        Object raw = result.get("attempts");
        if (raw instanceof List<?> attempts) {
            for (Object attempt : attempts) {
                if (attempt instanceof Map<?, ?> m && m.get("errors") instanceof List<?> errors) {
                    for (Object error : errors) {
                        if (error instanceof Map<?, ?> em && em.get("message") instanceof String msg) {
                            out.add(msg);
                        }
                    }
                }
            }
        }
        return out;
    }

    private static ToolContext contextWithSchemaCatalog(String schemaJson) {
        return contextWithEventsAndSchema(List.of(), null, List.of(Map.of(
                "description", "A2UI Component Schema \u2014 available components for generating UI surfaces. "
                        + "Use these component names and properties when creating A2UI operations.",
                "value", schemaJson)));
    }

    private static ToolContext contextWithEventsAndSchema(List<com.google.adk.events.Event> events,
                                                          String userNote) {
        List<Map<String, Object>> entries = new ArrayList<>();
        if (userNote != null) {
            entries.add(Map.of("description", "User preferences", "value", userNote));
        }
        entries.add(Map.of(
                "description", "A2UI Component Schema \u2014 available components for generating UI surfaces. "
                        + "Use these component names and properties when creating A2UI operations.",
                "value", schemaCatalogJson()));
        return contextWithEventsAndSchema(events, null, entries);
    }

    private static ToolContext contextWithEventsAndSchema(List<com.google.adk.events.Event> events,
                                                          String userNote,
                                                          List<Map<String, Object>> contextEntries) {
        InvocationContext invocation = mock(InvocationContext.class);
        Session session = mock(Session.class);
        when(invocation.session()).thenReturn(session);
        when(session.events()).thenReturn(events);
        ToolContext toolContext = mock(ToolContext.class);
        when(toolContext.invocationContext()).thenReturn(invocation);
        Map<String, Object> stateMap = new LinkedHashMap<>();
        stateMap.put(A2UISubAgentTool.CONTEXT_STATE_KEY, contextEntries);
        when(toolContext.state()).thenReturn(new State(stateMap));
        return toolContext;
    }

    private static ToolContext contextWithEvents(List<com.google.adk.events.Event> events) {
        InvocationContext invocation = mock(InvocationContext.class);
        Session session = mock(Session.class);
        when(invocation.session()).thenReturn(session);
        when(session.events()).thenReturn(events);
        ToolContext toolContext = mock(ToolContext.class);
        when(toolContext.invocationContext()).thenReturn(invocation);
        when(toolContext.state()).thenReturn(new State(Map.of()));
        return toolContext;
    }

    private static FunctionCall fc(String id) {
        return FunctionCall.builder().name(A2UISubAgentTool.RENDER_A2UI_NAME)
                .args(renderArgs(id)).build();
    }

    private static ToolContext context() {
        InvocationContext invocation = mock(InvocationContext.class);
        Session session = mock(Session.class);
        when(invocation.session()).thenReturn(session);
        when(session.events()).thenReturn(List.of());
        ToolContext context = mock(ToolContext.class);
        when(context.invocationContext()).thenReturn(invocation);
        when(context.state()).thenReturn(new State(Map.of()));
        return context;
    }

    private static Map<String, Object> args(String intent, String target, String changes) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("intent", intent);
        if (target != null) {
            args.put("target_surface_id", target);
        }
        if (changes != null) {
            args.put("changes", changes);
        }
        return args;
    }

    private static List<Event> drain(LinkedBlockingQueue<Event> queue) {
        List<Event> out = new ArrayList<>();
        queue.drainTo(out);
        out.removeIf(event -> event instanceof ToolCallEndEvent tce
                && "__a2ui_queue_done__".equals(tce.toolCallId()));
        return out;
    }
}
