package com.agui.adk.translator;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingCallStore;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.PendingToolCallEmitter;
import com.agui.adk.hitl.ToolCallLedger;
import com.agui.adk.translator.step.ToolCallTranslationStep;
import com.agui.adk.translator.step.ToolResultTranslationStep;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ToolTranslationStateMachineTest {

    @Test
    void productionTranslatorPropagatesNonSerializableToolArguments() {
        Map<String, Object> unsupported = Map.of("value", new Object());
        Event event = calls(callValue("provider-1", "weather", unsupported));

        assertThatThrownBy(() -> translate(event))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Failed to serialize tool-call arguments");
    }

    @Test
    void emitsOneLifecycleForPartialAndFinalViewsOfTheSameCall() {
        List<com.agui.community.core.event.Event> events = translate(
                call("provider-1", "weather", true), call("provider-1", "weather", false));

        assertThat(events).hasSize(3);
        assertThat(events).extracting(Object::getClass)
                .containsExactly(ToolCallStartEvent.class, ToolCallArgsEvent.class, ToolCallEndEvent.class);
    }

    @Test
    void generatesStableDistinctIdsForMissingProviderIds() {
        List<com.agui.community.core.event.Event> events = translate(
                call(null, "weather", false), call(null, "weather", false));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance)
                .extracting(event -> ((ToolCallStartEvent) event).toolCallId())
                .hasSize(2).doesNotHaveDuplicates();
    }

    @Test
    void keepsSameNameCallsDistinctAndInProviderOrder() {
        List<com.agui.community.core.event.Event> events = translate(
                calls(callValue("a", "search"), callValue("b", "search")));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance)
                .extracting(event -> ((ToolCallStartEvent) event).toolCallId())
                .containsExactly("a", "b");
    }

    @Test
    void correlatesServerResultWithTheExactProviderCallId() {
        List<com.agui.community.core.event.Event> events = translate(
                call("provider-1", "weather", false), response("provider-1", "weather"));

        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance)
                .extracting(event -> ((ToolCallResultEvent) event).toolCallId())
                .containsExactly("provider-1");
    }

    @Test
    void doesNotSynthesizeAServerResultForAFrontendTool() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.configureFrontendToolPersistence(new PendingCallScope("app", "user", "session"), "invocation",
                Set.of("browser"), new PendingToolCallEmitter(new PendingCallStore() {
                    @Override public io.reactivex.rxjava3.core.Completable persist(PendingToolCall call) {
                        return io.reactivex.rxjava3.core.Completable.complete();
                    }
                    @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return Flowable.empty(); }
                }, event -> new EncodedEvent(event, "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\""
                        + event.toolCallId() + "\",\"toolCallName\":\"" + event.toolCallName()
                        + "\",\"delta\":\"{}\"}"), new ToolCallLedger()));

        List<com.agui.community.core.event.Event> events = translate(context,
                call("provider-1", "browser", false), response("provider-1", "browser"));

        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance).isEmpty();
    }

    @Test
    void suppressesServerResultForABackendLongRunningTool() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.populateLongRunningToolIds(Set.of("provider-1"));

        List<com.agui.community.core.event.Event> events = translate(context,
                call("provider-1", "weather", false), response("provider-1", "weather"));

        // Python suppresses TOOL_CALL_RESULT for *every* id in long_running_tool_ids, including a
        // native ADK LongRunningFunctionTool that is not an AG-UI frontend proxy: the call stays
        // owned by the frontend for the rest of the turn, so a backend result would render a
        // premature "completed" state or duplicate the real one (parity finding F-03).
        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance).isEmpty();
    }

    @Test
    void remapsAConfirmedResultIdOntoTheStreamingIdTheClientSaw() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.enableStreamingFcArgs();
        // Mode A already opened TOOL_CALL_START under a stable synthetic id for this call.
        context.completeStreamingFc("weather", "streaming-1");

        List<com.agui.community.core.event.Event> events = translate(context,
                call("provider-1", "weather", false), response("provider-1", "weather"));

        // The aggregated confirmed call is suppressed, and its result is published under the
        // streaming id so it correlates with the call the client opened instead of orphaning
        // ("No function call event found"). Python `_confirmed_to_streaming_id` (parity F-04).
        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance).isEmpty();
        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance)
                .extracting(event -> ((ToolCallResultEvent) event).toolCallId())
                .containsExactly("streaming-1");
    }

    @Test
    void suppressesToolCallResultForAPredictiveBackendTool() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run",
                List.of(new PredictStateMapping("weather", false, Map.of("status", "loading"))));

        List<com.agui.community.core.event.Event> events = Flowable.fromPublisher(translator.apply(Flowable.fromArray(
                call("provider-1", "weather", false), response("provider-1", "weather")))).toList().blockingGet();

        // Python suppresses TOOL_CALL_RESULT for predictive-state tools so the frontend does not
        // raise "No function call event found"; the state machine shows the lifecycle + PredictState.
        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance).isEmpty();
        assertThat(events).filteredOn(com.agui.community.core.event.CustomEvent.class::isInstance)
                .singleElement()
                .extracting(com.agui.community.core.event.CustomEvent.class::cast)
                .extracting(com.agui.community.core.event.CustomEvent::name)
                .isEqualTo("PredictState");
    }

    @Test
    void suppressesDuplicateServerResults() {
        List<com.agui.community.core.event.Event> events = translate(
                response("provider-1", "weather"), response("provider-1", "weather"));

        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance).hasSize(1);
    }

    @Test
    void emitsTheRicherFinalPayloadInsteadOfThePartialPreview() {
        List<com.agui.community.core.event.Event> events = translate(
                calls(List.of(callValue("provider-1", "weather", Map.of("city", "Paris"))), true),
                calls(List.of(callValue("provider-1", "weather", Map.of("city", "Paris", "units", "metric"))), false));

        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance)
                .extracting(event -> ((ToolCallArgsEvent) event).delta())
                .singleElement()
                .satisfies(args -> {
                    assertThat(args).contains("\"city\":\"Paris\"");
                    assertThat(args).contains("\"units\":\"metric\"");
                });
    }

    @Test
    void keepsMissingIdStableBetweenPartialAndFinalViews() {
        List<com.agui.community.core.event.Event> events = translate(
                call(null, "weather", true), call(null, "weather", false));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance)
                .extracting(event -> ((ToolCallStartEvent) event).toolCallId())
                .singleElement();
    }

    @Test
    void correlatesAMissingIdResultWithItsCall() {
        List<com.agui.community.core.event.Event> events = translate(
                call(null, "weather", false), response(null, "weather"));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance)
                .extracting(event -> ((ToolCallStartEvent) event).toolCallId())
                .containsExactlyElementsOf(events.stream().filter(ToolCallResultEvent.class::isInstance)
                        .map(ToolCallResultEvent.class::cast).map(ToolCallResultEvent::toolCallId).toList());
    }

    @Test
    void keepsSameNameMissingIdSiblingsDistinctOrderedAndCorrelatesTheirResults() {
        List<com.agui.community.core.event.Event> events = translate(
                calls(callValue(null, "weather"), callValue(null, "weather")),
                responses(responseValue(null, "weather"), responseValue(null, "weather")));

        List<String> callIds = events.stream().filter(ToolCallStartEvent.class::isInstance)
                .map(ToolCallStartEvent.class::cast).map(ToolCallStartEvent::toolCallId).toList();
        assertThat(callIds).hasSize(2).doesNotHaveDuplicates();
        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance)
                .extracting(event -> ((ToolCallResultEvent) event).toolCallId())
                .containsExactlyElementsOf(callIds);
    }

    @Test
    void correlatesPartialSameNameMissingIdSiblingResultsInFifoOrder() {
        List<com.agui.community.core.event.Event> events = translate(
                calls(List.of(callValue(null, "weather", Map.of("city", "Paris")),
                        callValue(null, "weather", Map.of("city", "Berlin"))), true),
                responses(responseValue(null, "weather", Map.of("forecast", "sun")),
                        responseValue(null, "weather", Map.of("forecast", "rain"))));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance)
                .extracting(event -> ((ToolCallStartEvent) event).toolCallId())
                .containsExactly("run:tool:1", "run:tool:2");
        assertThat(events).filteredOn(ToolCallResultEvent.class::isInstance)
                .extracting(event -> (ToolCallResultEvent) event)
                .extracting(ToolCallResultEvent::toolCallId, ToolCallResultEvent::content)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("run:tool:1", "{\"forecast\":\"sun\"}"),
                        org.assertj.core.groups.Tuple.tuple("run:tool:2", "{\"forecast\":\"rain\"}"));
    }

    @Test
    void suppressesArgsPhaseWhenBackendArgsAreAbsent() {
        List<com.agui.community.core.event.Event> events = translate(backendCallWithoutArgs("provider-1", "weather"));

        assertThat(events).extracting(Object::getClass)
                .containsExactly(ToolCallStartEvent.class, ToolCallEndEvent.class);
        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance).isEmpty();
    }

    @Test
    void flushesAPartialOnlyToolCallWhenUpstreamCompletes() {
        List<com.agui.community.core.event.Event> events = translate(call("provider-1", "weather", true));

        assertThat(events).extracting(Object::getClass)
                .containsExactly(ToolCallStartEvent.class, ToolCallArgsEvent.class, ToolCallEndEvent.class);
    }

    @Test
    void flushesInterleavedPartialCallsInGlobalProviderArrivalOrder() {
        List<com.agui.community.core.event.Event> events = translate(
                call(null, "alpha", true), call("provider-beta", "beta", true),
                call(null, "gamma", true), call("provider-delta", "delta", true));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance)
                .extracting(event -> (ToolCallStartEvent) event)
                .extracting(ToolCallStartEvent::toolCallName, ToolCallStartEvent::toolCallId)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("alpha", "run:tool:1"),
                        org.assertj.core.groups.Tuple.tuple("beta", "provider-beta"),
                        org.assertj.core.groups.Tuple.tuple("gamma", "run:tool:2"),
                        org.assertj.core.groups.Tuple.tuple("delta", "provider-delta"));
    }

    @Test
    void flushesPartialBackendLifecycleBeforeItsCorrelatedResult() {
        List<com.agui.community.core.event.Event> events = translate(
                call("provider-1", "weather", true), response("provider-1", "weather"));

        assertThat(events).extracting(Object::getClass).containsExactly(
                ToolCallStartEvent.class, ToolCallArgsEvent.class, ToolCallEndEvent.class, ToolCallResultEvent.class);
    }


    @Test
    void emitsToolCallThoughtSignatureAsToolCallEncryptedValue() {
        Event signed = Event.builder().author("model")
                .content(Content.builder().role("model").parts(
                        Part.builder().functionCall(FunctionCall.builder().id("provider-1").name("weather")
                                .args(Map.of("city", "Paris")).build())
                                .thoughtSignature(new byte[]{1,2,3,4}).build()).build())
                .build();

        List<com.agui.community.core.event.Event> events = translate(signed);

        assertThat(events).filteredOn(com.agui.community.core.event.ReasoningEncryptedValueEvent.class::isInstance)
                .singleElement()
                .satisfies(e -> {
                    com.agui.community.core.event.ReasoningEncryptedValueEvent rev =
                            (com.agui.community.core.event.ReasoningEncryptedValueEvent) e;
                    assertThat(rev.subtype()).isEqualTo("tool-call");
                    assertThat(rev.entityId()).isEqualTo("provider-1");
                    assertThat(rev.encryptedValue()).isEqualTo(java.util.Base64.getEncoder().encodeToString(
                            new byte[]{1,2,3,4}));
                });
    }

    @Test
    void emitsToolCallThoughtSignatureOnlyOnceForReplayedOrDedupedCalls() {
        Event signed = Event.builder().author("model")
                .content(Content.builder().role("model").parts(
                        Part.builder().functionCall(FunctionCall.builder().id("provider-1").name("weather")
                                .args(Map.of("city", "Paris")).build())
                                .thoughtSignature(new byte[]{1,2,3,4}).build()).build())
                .build();

        List<com.agui.community.core.event.Event> events = translate(signed, signed);

        assertThat(events).filteredOn(com.agui.community.core.event.ReasoningEncryptedValueEvent.class::isInstance)
                .hasSize(1);
    }

    private static List<com.agui.community.core.event.Event> translate(Event... events) {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");
        return Flowable.fromPublisher(
                translator.apply(Flowable.fromArray(events))).toList().blockingGet();
    }

    @Test
    void emitsLongRunningCallAfterPartialThenCompleteViewsWithSameId() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.populateLongRunningToolIds(Set.of("lro-1"));

        List<com.agui.community.core.event.Event> events = translate(context,
                call("lro-1", "confirm_action", true),
                call("lro-1", "confirm_action", false));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance)
                .extracting(event -> ((ToolCallStartEvent) event).toolCallId())
                .containsExactly("lro-1");
    }

    @Test
    void suppressesPositionalReplayOfLongRunningCallsEmittedUnderDifferentIds() {
        // SSE re-delivers the same logical LRO call under a different ID (#1168):
        // the 1st same-name LRO call in a later event is a replay if we already
        // emitted a same-name LRO call this run.
        TranslationContext context = new TranslationContext("thread", "run");

        context.populateLongRunningToolIds(Set.of("lro-1"));
        List<com.agui.community.core.event.Event> first = translate(context,
                call("lro-1", "weather", false));
        assertThat(first).filteredOn(ToolCallStartEvent.class::isInstance).hasSize(1);

        context.populateLongRunningToolIds(Set.of("lro-2"));
        List<com.agui.community.core.event.Event> replay = translate(context,
                call("lro-2", "weather", false));
        assertThat(replay).filteredOn(ToolCallStartEvent.class::isInstance).isEmpty();
    }

    @Test
    void emitsParallelSameNameLongRunningCallsInOneEvent() {
        // Genuinely parallel same-name LRO calls arrive as multiple parts of ONE
        // event; they exceed the per-name high-water mark and each emit individually.
        TranslationContext context = new TranslationContext("thread", "run");
        context.populateLongRunningToolIds(Set.of("lro-a", "lro-b"));

        List<com.agui.community.core.event.Event> events = translate(context,
                calls(java.util.List.of(
                        callValue("lro-a", "weather"),
                        callValue("lro-b", "weather")), false));

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance).hasSize(2);
    }

    private static List<com.agui.community.core.event.Event> translate(TranslationContext context, Event... events) {
        return Flowable.fromArray(events).concatMap(event -> Flowable.concat(
                        ToolCallTranslationStep.INSTANCE.translate(event, context),
                        ToolResultTranslationStep.INSTANCE.translate(event, context)))
                .toList().blockingGet();
    }

    private static Event call(String id, String name, boolean partial) {
        return calls(callValue(id, name), partial);
    }

    private static Event calls(FunctionCall... calls) {
        return calls(List.of(calls), false);
    }

    private static Event calls(FunctionCall call, boolean partial) {
        return calls(List.of(call), partial);
    }

    private static Event calls(List<FunctionCall> calls, boolean partial) {
        return Event.builder().author("model").partial(partial)
                .content(Content.builder().role("model").parts(calls.stream()
                        .map(call -> Part.builder().functionCall(call).build()).toList()).build())
                .build();
    }

    private static FunctionCall callValue(String id, String name) {
        return callValue(id, name, Map.of("city", "Paris"));
    }

    private static FunctionCall callValue(String id, String name, Map<String, Object> args) {
        FunctionCall.Builder builder = FunctionCall.builder().name(name).args(args);
        if (id != null) {
            builder.id(id);
        }
        return builder.build();
    }

    private static Event backendCallWithoutArgs(String id, String name) {
        FunctionCall.Builder call = FunctionCall.builder().name(name);
        if (id != null) {
            call.id(id);
        }
        return calls(call.build());
    }

    private static Event response(String id, String name) {
        return responses(responseValue(id, name));
    }

    private static Event responses(FunctionResponse... responses) {
        return Event.builder().author("tool").content(Content.builder().role("tool").parts(
                java.util.Arrays.stream(responses).map(response -> Part.builder().functionResponse(response).build()).toList())
                .build()).build();
    }

    private static FunctionResponse responseValue(String id, String name) {
        return responseValue(id, name, Map.of("ok", true));
    }

    private static FunctionResponse responseValue(String id, String name, Map<String, Object> payload) {
        FunctionResponse.Builder response = FunctionResponse.builder().name(name).response(payload);
        if (id != null) {
            response.id(id);
        }
        return response.build();
    }
}
