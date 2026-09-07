package com.agui.adk.translator;

import com.google.adk.events.Event;
import com.google.adk.events.EventActions;
import com.google.adk.sessions.State;
import com.agui.community.core.event.JsonPatchOperation;
import com.agui.community.core.event.StateDeltaEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class StateTranslationTest {
    @Test
    void emitsNoSnapshotForRunWithoutStateDeltas() {
        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run")
                        .apply(io.reactivex.rxjava3.core.Flowable.empty())).toList().blockingGet();

        assertThat(events).isEmpty();
    }

    @Test
    void seedsFullSessionStateStripsTempKeysAndAppliesRunDeltaOnTop() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");
        translator.seedSessionState(Map.of(
                "fromEarlierTurn", "kept",
                "overwritten", "old",
                "temp:requestOnly", "hidden"));
        Event delta = Event.builder().actions(EventActions.builder().stateDelta(Map.of(
                "overwritten", "new",
                "fromCurrentTurn", true,
                "temp:currentRequest", "hidden-too")).build()).build();

        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                translator.apply(io.reactivex.rxjava3.core.Flowable.just(delta))).toList().blockingGet();

        assertThat(events.getLast()).isEqualTo(new StateSnapshotEvent(Map.of(
                "fromEarlierTurn", "kept",
                "overwritten", "new",
                "fromCurrentTurn", true)));
    }

    @Test
    void emitsPythonCompatibleRawPathsAndRemovalValuesThenCanonicalSnapshot() {
        Map<String, Object> delta = new LinkedHashMap<>();
        delta.put("a/b~c", "value");
        delta.put("remove", State.REMOVED);
        delta.put("nested", java.util.Collections.singletonMap("null", null));
        delta.put("_ag_ui_internal", "hidden");
        delta.put("temp:scratch", "hidden-too");
        Event event = Event.builder().actions(EventActions.builder().stateDelta(delta).build()).build();

        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run")
                        .apply(io.reactivex.rxjava3.core.Flowable.just(event))).toList().blockingGet();

        assertThat(events.getFirst()).isInstanceOf(StateDeltaEvent.class);
        List<JsonPatchOperation> patches = ((StateDeltaEvent) events.getFirst()).delta();
        assertThat(patches).contains(new JsonPatchOperation("add", "/a/b~c", "value"),
                new JsonPatchOperation("add", "/remove", State.REMOVED),
                new JsonPatchOperation("add", "/nested", java.util.Collections.singletonMap("null", null)),
                new JsonPatchOperation("add", "/_ag_ui_internal", "hidden"));
        assertThat(patches).noneMatch(patch -> patch.path().startsWith("/temp:"));
        assertThat(events.getLast()).isInstanceOf(StateSnapshotEvent.class);
        assertThat(((StateSnapshotEvent) events.getLast()).snapshot())
                .isEqualTo(Map.of(
                        "a/b~c", "value",
                        "nested", java.util.Collections.singletonMap("null", null),
                        "_ag_ui_internal", "hidden"));
    }

    @Test
    void defensivelyCopiesNestedPatchValuesWhileRetainingJsonNulls() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("items", new java.util.ArrayList<>(java.util.Arrays.asList("before", null)));
        Event event = Event.builder().actions(EventActions.builder().stateDelta(Map.of("nested", nested)).build()).build();
        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run").apply(io.reactivex.rxjava3.core.Flowable.just(event)))
                .toList().blockingGet();
        ((List<Object>) nested.get("items")).set(0, "after");

        assertThat(((StateDeltaEvent) events.getFirst()).delta()).containsExactly(
                new JsonPatchOperation("add", "/nested", Map.of("items", java.util.Arrays.asList("before", null))));
    }

    @Test
    void appliesPredictiveToolStateThroughProductionPipelineToFinalSnapshot() {
        Event tool = Event.builder().content(com.google.genai.types.Content.builder().parts(
                com.google.genai.types.Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                        .id("call").name("save").args(Map.of()).build()).build()).build()).build();
        Event delta = Event.builder().actions(EventActions.builder().stateDelta(Map.of("count", 1, "_ag_ui_hidden", true)).build()).build();
        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run", List.of(
                        new PredictStateMapping("save", false, Map.of("status", "loading"))))
                        .apply(io.reactivex.rxjava3.core.Flowable.just(tool, delta))).toList().blockingGet();

        assertThat(events.getLast()).isEqualTo(new StateSnapshotEvent(Map.of(
                "status", "loading", "count", 1, "_ag_ui_hidden", true)));
    }

    @Test
    void emitsVisibleStateDeltaWithoutClosingPartialText() {
        Event textAndState = Event.builder().author("model").partial(true).content(
                com.google.genai.types.Content.builder().parts(com.google.genai.types.Part.builder()
                        .text("Working").build()).build()).actions(
                EventActions.builder().stateDelta(Map.of("phase", "running")).build()).build();

        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run")
                        .apply(io.reactivex.rxjava3.core.Flowable.just(textAndState))).toList().blockingGet();

        assertThat(events).extracting(Object::getClass).containsExactly(
                com.agui.community.core.event.TextMessageStartEvent.class,
                com.agui.community.core.event.TextMessageContentEvent.class,
                StateDeltaEvent.class,
                com.agui.community.core.event.TextMessageEndEvent.class, StateSnapshotEvent.class);
        assertThat(events.getLast()).isEqualTo(new StateSnapshotEvent(Map.of("phase", "running")));
    }

    @Test
    void emitsVisibleStateDeltaWithoutClosingOpenReasoning() {
        Event reasoning = Event.builder().id("thought").author("model").partial(true).content(
                com.google.genai.types.Content.builder().parts(com.google.genai.types.Part.builder()
                        .text("analysis").thought(true).build()).build()).build();
        Event state = Event.builder().partial(true).actions(EventActions.builder().stateDelta(Map.of("phase", "running")).build()).build();

        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run").apply(io.reactivex.rxjava3.core.Flowable.just(reasoning, state)))
                .toList().blockingGet();

        assertThat(events).extracting(Object::getClass).containsExactly(
                com.agui.community.core.event.ReasoningStartEvent.class,
                com.agui.community.core.event.ReasoningMessageStartEvent.class,
                com.agui.community.core.event.ReasoningMessageContentEvent.class,
                StateDeltaEvent.class,
                com.agui.community.core.event.ReasoningMessageEndEvent.class,
                com.agui.community.core.event.ReasoningEndEvent.class, StateSnapshotEvent.class);
    }

    @Test
    void authoritativeFinalStateReplacesPreRunProjectionAndKeepsPredictiveOverlay() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run", List.of(
                new PredictStateMapping("save", false, Map.of("status", "loading"))));
        translator.seedSessionState(Map.of("stale", "before"));
        Event tool = Event.builder().content(com.google.genai.types.Content.builder().parts(
                com.google.genai.types.Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                        .id("call").name("save").args(Map.of()).build()).build()).build()).build();
        io.reactivex.rxjava3.core.Flowable.fromPublisher(
                translator.apply(io.reactivex.rxjava3.core.Flowable.just(tool))).toList().blockingGet();

        List<com.agui.community.core.event.Event> events = translator.finalStateSnapshot(Map.of(
                "directMutation", "persisted",
                "status", "stored",
                "temp:scratch", "hidden",
                "_ag_ui_internal", "hidden-too")).toList().blockingGet();

        assertThat(events).containsExactly(new StateSnapshotEvent(Map.of(
                "directMutation", "persisted",
                "status", "loading",
                "_ag_ui_internal", "hidden-too")));
    }

    @Test
    void authoritativeEmptyStateEmitsNoSnapshot() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");

        assertThat(translator.finalStateSnapshot(Map.of()).toList().blockingGet()).isEmpty();
    }

}
