package com.agui.adk.translator;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.google.genai.types.PartialArg;
import com.agui.adk.translator.step.ToolCallTranslationStep;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** P0 #3 — Mode-A streaming function-call arguments (Python test_streaming_fc_args.py). */
class StreamingFunctionCallArgumentsTest {

    private static List<com.agui.community.core.event.Event> step(TranslationContext context, Event event) {
        return ToolCallTranslationStep.INSTANCE.translate(event, context).toList().blockingGet();
    }

    private static Event event(List<FunctionCall> calls) {
        return Event.builder().author("model").partial(true)
                .content(Content.builder().role("model").parts(calls.stream()
                        .map(call -> Part.builder().functionCall(call).build()).toList()).build())
                .build();
    }

    private static FunctionCall firstChunk(String name) {
        return FunctionCall.builder().name(name).willContinue(true).build();
    }

    private static FunctionCall continuation(String jsonPath, String value) {
        return FunctionCall.builder()
                .partialArgs(List.of(PartialArg.builder().jsonPath(jsonPath).stringValue(value).build()))
                .willContinue(true).build();
    }

    private static FunctionCall endMarker() {
        return FunctionCall.builder().build();
    }

    @Test
    void firstChunkEmitsStart() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.enableStreamingFcArgs();

        List<com.agui.community.core.event.Event> events = step(context, event(List.of(firstChunk("write_document"))));

        assertThat(events).hasSize(1);
        assertThat(events.get(0)).isInstanceOf(ToolCallStartEvent.class);
        ToolCallStartEvent start = (ToolCallStartEvent) events.get(0);
        assertThat(start.toolCallName()).isEqualTo("write_document");
        assertThat(start.toolCallId()).isNotNull();
    }

    @Test
    void factoryEnablesProgressiveArgumentsByDefault() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");

        List<com.agui.community.core.event.Event> events = Flowable.fromPublisher(translator.apply(Flowable.fromArray(
                event(List.of(firstChunk("write_document"))),
                event(List.of(continuation("$.document", "Hello "))),
                event(List.of(continuation("$.document", "World"))),
                event(List.of(endMarker()))))).toList().blockingGet();

        assertThat(events).extracting(Object::getClass).containsExactly(
                ToolCallStartEvent.class,
                ToolCallArgsEvent.class,
                ToolCallArgsEvent.class,
                ToolCallArgsEvent.class,
                ToolCallEndEvent.class);
        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance)
                .extracting(event -> ((ToolCallArgsEvent) event).delta())
                .containsExactly("{\"document\": \"Hello ", "World", "\"}");
    }

    @Test
    void factoryCanDisableProgressiveArgumentsExplicitly() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create(
                "thread", "run", List.of(), java.util.Set.of(), false);

        List<com.agui.community.core.event.Event> events = Flowable.fromPublisher(translator.apply(
                Flowable.just(event(List.of(firstChunk("write_document")))))).toList().blockingGet();

        assertThat(events).filteredOn(ToolCallStartEvent.class::isInstance).hasSize(1);
        assertThat(events).filteredOn(ToolCallEndEvent.class::isInstance).hasSize(1);
        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance).isEmpty();
    }

    @Test
    void streamingCallWithoutArgumentChunksEmitsOnlyStartAndEnd() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");

        List<com.agui.community.core.event.Event> events = Flowable.fromPublisher(translator.apply(Flowable.fromArray(
                event(List.of(firstChunk("no_args"))),
                event(List.of(endMarker()))))).toList().blockingGet();

        assertThat(events).extracting(Object::getClass)
                .containsExactly(ToolCallStartEvent.class, ToolCallEndEvent.class);
        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance).isEmpty();
    }

    @Test
    void continuationEmitsArgsDeltas() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.enableStreamingFcArgs();

        step(context, event(List.of(firstChunk("write_document"))));
        List<com.agui.community.core.event.Event> events = step(context,
                event(List.of(continuation("$.document", "Hello world"))));

        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance).isNotEmpty();
        ToolCallArgsEvent args = (ToolCallArgsEvent) events.stream()
                .filter(ToolCallArgsEvent.class::isInstance).findFirst().orElseThrow();
        assertThat(args.delta()).contains("document");
        assertThat(args.delta()).contains("Hello world");
    }

    @Test
    void secondContinuationIsJustTheEscapedFragment() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.enableStreamingFcArgs();

        step(context, event(List.of(firstChunk("write_document"))));
        step(context, event(List.of(continuation("$.document", "Once upon "))));
        List<com.agui.community.core.event.Event> events = step(context,
                event(List.of(continuation("$.document", "a time"))));

        ToolCallArgsEvent args = (ToolCallArgsEvent) events.stream()
                .filter(ToolCallArgsEvent.class::isInstance).findFirst().orElseThrow();
        assertThat(args.delta()).isEqualTo("a time");
    }

    @Test
    void endMarkerEmitsClosingJsonAndEnd() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.enableStreamingFcArgs();

        step(context, event(List.of(firstChunk("write_document"))));
        step(context, event(List.of(continuation("$.document", "content"))));
        List<com.agui.community.core.event.Event> events = step(context, event(List.of(endMarker())));

        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance).isNotEmpty();
        ToolCallArgsEvent closing = (ToolCallArgsEvent) events.stream()
                .filter(ToolCallArgsEvent.class::isInstance).findFirst().orElseThrow();
        assertThat(closing.delta()).isEqualTo("\"}");
        assertThat(events).filteredOn(ToolCallEndEvent.class::isInstance).isNotEmpty();
    }

    @Test
    void defersToolCallEndWhenStreamToolCallIsEnabled() {
        List<PredictStateMapping> config = List.of(
                new PredictStateMapping("write_document", true, true, null, null, Map.of()));
        TranslationContext context = new TranslationContext("thread", "run", config);
        context.enableStreamingFcArgs();

        step(context, event(List.of(firstChunk("write_document"))));
        step(context, event(List.of(continuation("$.document", "content"))));
        List<com.agui.community.core.event.Event> events = step(context, event(List.of(endMarker())));

        // stream_tool_call=True defers TOOL_CALL_END to keep the call open for LRO/HITL flows.
        assertThat(events).filteredOn(ToolCallArgsEvent.class::isInstance).isNotEmpty();
        assertThat(events).filteredOn(ToolCallEndEvent.class::isInstance).isEmpty();
    }

    @Test
    void emitsToolCallEndWhenStreamToolCallIsDisabled() {
        List<PredictStateMapping> config = List.of(
                new PredictStateMapping("write_document", true, Map.of()));
        TranslationContext context = new TranslationContext("thread", "run", config);
        context.enableStreamingFcArgs();

        step(context, event(List.of(firstChunk("write_document"))));
        step(context, event(List.of(continuation("$.document", "content"))));
        List<com.agui.community.core.event.Event> events = step(context, event(List.of(endMarker())));

        assertThat(events).filteredOn(ToolCallEndEvent.class::isInstance).isNotEmpty();
    }

    @Test
    void fullSequenceProducesStartArgsArgsCloseEnd() {
        TranslationContext context = new TranslationContext("thread", "run");
        context.enableStreamingFcArgs();
        List<com.agui.community.core.event.Event> all = new ArrayList<>();

        all.addAll(step(context, event(List.of(firstChunk("write_document")))));
        all.addAll(step(context, event(List.of(continuation("$.document", "Hello ")))));
        all.addAll(step(context, event(List.of(continuation("$.document", "World")))));
        all.addAll(step(context, event(List.of(endMarker()))));

        assertThat(all.get(0)).isInstanceOf(ToolCallStartEvent.class);
        assertThat(all.get(all.size() - 1)).isInstanceOf(ToolCallEndEvent.class);
        assertThat(all.stream().filter(ToolCallArgsEvent.class::isInstance).count()).isEqualTo(3);

        // Concatenated ARGS deltas must form valid JSON.
        String fullJson = all.stream().filter(ToolCallArgsEvent.class::isInstance)
                .map(e -> ((ToolCallArgsEvent) e).delta()).collect(java.util.stream.Collectors.joining());
        assertThat(new com.google.gson.Gson().fromJson(fullJson, java.util.Map.class))
                .isEqualTo(java.util.Map.of("document", "Hello World"));
    }
}
