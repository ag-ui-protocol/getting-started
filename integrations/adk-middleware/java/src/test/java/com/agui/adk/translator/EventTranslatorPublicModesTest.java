package com.agui.adk.translator;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Audit finding M-28: the public {@link EventTranslator} must expose the specialized single-event
 * modes the Python run-loop uses — {@code translate_text_only}, {@code translate_lro_function_calls},
 * {@code force_close_streaming_message} and {@code reset} — so embedders can order text before LRO
 * calls and reuse one translator across runs.
 */
class EventTranslatorPublicModesTest {

    @Test
    void translateTextOnlyTranslatesTextAndIgnoresFunctionCalls() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run", List.of());

        List<com.agui.community.core.event.Event> events = block(
                translator.translateTextOnly(eventWithTextAndCalls()));

        assertThat(events).hasSize(3);
        assertThat(events.get(0)).isInstanceOf(TextMessageStartEvent.class);
        assertThat(events.get(1)).isInstanceOf(TextMessageContentEvent.class);
        assertThat(events.get(2)).isInstanceOf(TextMessageEndEvent.class);
        assertThat(events).noneMatch(ToolCallStartEvent.class::isInstance);
    }

    @Test
    void translateLroFunctionCallsTranslatesOnlyLongRunningCalls() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run", List.of());

        List<com.agui.community.core.event.Event> events = block(
                translator.translateLroFunctionCalls(eventWithLroAndRegularCalls()));

        assertThat(events).extracting(Object::getClass).containsExactly(
                ToolCallStartEvent.class, ToolCallArgsEvent.class, ToolCallEndEvent.class);
        ToolCallStartEvent start = (ToolCallStartEvent) events.get(0);
        assertThat(start.toolCallId()).isEqualTo("lro-1");
    }

    @Test
    void forceCloseStreamingMessageEmitsEndForAnOpenStream() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run", List.of());

        block(translator.translateTextOnly(partialTextEvent("Hello ")));

        List<com.agui.community.core.event.Event> close = block(translator.forceCloseStreamingMessage());

        assertThat(close).hasSize(1);
        assertThat(close.get(0)).isInstanceOf(TextMessageEndEvent.class);
        // A second close is a no-op: the stream is already terminated.
        assertThat(block(translator.forceCloseStreamingMessage())).isEmpty();
    }

    @Test
    void resetClearsEmissionStateSoTheSameEventCanBeTranslatedAgain() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run", List.of());
        Event lroEvent = eventWithLroAndRegularCalls();

        List<com.agui.community.core.event.Event> first = block(translator.translateLroFunctionCalls(lroEvent));
        assertThat(first).extracting(Object::getClass).containsExactly(
                ToolCallStartEvent.class, ToolCallArgsEvent.class, ToolCallEndEvent.class);

        // Without a reset the already-emitted call is suppressed on replay (SSE redelivery).
        assertThat(block(translator.translateLroFunctionCalls(lroEvent))).isEmpty();

        translator.reset();

        List<com.agui.community.core.event.Event> afterReset = block(translator.translateLroFunctionCalls(lroEvent));
        assertThat(afterReset).extracting(Object::getClass).containsExactly(
                ToolCallStartEvent.class, ToolCallArgsEvent.class, ToolCallEndEvent.class);
    }

    @Test
    void dedicatedLroRouteEmitsTextCloseThenOnlyTheLongRunningCall() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run", List.of());
        Event event = Event.builder().author("model").partial(true).longRunningToolIds(Set.of("lro-1"))
                .content(Content.builder().role("model").parts(List.of(
                        Part.builder().text("Before tool").build(),
                        Part.builder().functionCall(FunctionCall.builder().id("lro-1").name("lro_tool")
                                .args(Map.of("q", "1")).build()).build(),
                        Part.builder().functionCall(FunctionCall.builder().id("n-1").name("normal_tool")
                                .args(Map.of("q", "2")).build()).build())).build()).build();

        List<com.agui.community.core.event.Event> events = block(translator.translateLongRunningEvent(event));

        assertThat(events).extracting(Object::getClass).containsExactly(
                TextMessageStartEvent.class, TextMessageContentEvent.class, TextMessageEndEvent.class,
                ToolCallStartEvent.class, ToolCallArgsEvent.class, ToolCallEndEvent.class);
        assertThat(((ToolCallStartEvent) events.get(3)).toolCallId()).isEqualTo("lro-1");
    }

    @Test
    void capturesPersistedLroIdForTheClientFacingPartialId() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run", List.of());
        block(translator.translateLroFunctionCalls(Event.builder().author("model").partial(true)
                .longRunningToolIds(Set.of("partial-id")).content(Content.builder().parts(
                        Part.builder().functionCall(FunctionCall.builder().id("partial-id").name("lro_tool")
                                .args(Map.of()).build()).build()).build()).build()));
        translator.capturePersistedLroIds(Event.builder().author("model").longRunningToolIds(Set.of("persisted-id"))
                .content(Content.builder().parts(Part.builder().functionCall(FunctionCall.builder()
                        .id("persisted-id").name("lro_tool").args(Map.of()).build()).build()).build()).build());

        assertThat(translator.drainLroIdRemap()).containsExactlyEntriesOf(
                Map.of("partial-id", "persisted-id"));
        assertThat(translator.drainLroIdRemap()).isEmpty();
    }

    private static Event eventWithTextAndCalls() {
        return Event.builder().author("model")
                .content(Content.builder().role("model").parts(List.of(
                        Part.builder().text("Hello").build(),
                        Part.builder().functionCall(FunctionCall.builder().id("lro-1").name("lro_tool")
                                .args(Map.of("q", "1")).build()).build(),
                        Part.builder().functionCall(FunctionCall.builder().id("n-1").name("normal_tool")
                                .args(Map.of("q", "2")).build()).build()))
                        .build())
                .build();
    }

    private static Event eventWithLroAndRegularCalls() {
        return Event.builder().author("model")
                .longRunningToolIds(Set.of("lro-1"))
                .content(Content.builder().role("model").parts(List.of(
                        Part.builder().functionCall(FunctionCall.builder().id("lro-1").name("lro_tool")
                                .args(Map.of("q", "1")).build()).build(),
                        Part.builder().functionCall(FunctionCall.builder().id("n-1").name("normal_tool")
                                .args(Map.of("q", "2")).build()).build()))
                        .build())
                .build();
    }

    private static Event partialTextEvent(String text) {
        return Event.builder().author("model").partial(true)
                .content(Content.builder().role("model")
                        .parts(List.of(Part.builder().text(text).build())).build())
                .build();
    }

    private static List<com.agui.community.core.event.Event> block(
            Flowable<com.agui.community.core.event.Event> flow) {
        return flow.toList().blockingGet();
    }
}
