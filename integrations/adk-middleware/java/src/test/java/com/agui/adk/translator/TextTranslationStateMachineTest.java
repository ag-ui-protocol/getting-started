package com.agui.adk.translator;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class TextTranslationStateMachineTest {

    @Test
    void emitsPartialDeltasOnceAndSuppressesTheFinalAggregate() {
        List<com.agui.community.core.event.Event> events = translate(
                modelText("Hello ", true, false, false),
                modelText("world", true, false, false),
                modelText("Hello world", false, true, true));

        assertThat(events).hasSize(4);
        assertThat(events.get(0)).isInstanceOf(TextMessageStartEvent.class);
        assertThat(content(events)).containsExactly("Hello ", "world");
        assertThat(events.get(3)).isInstanceOf(TextMessageEndEvent.class);
    }

    @Test
    void emitsCompleteMessageForNonPartialNonFinalText() {
        List<com.agui.community.core.event.Event> events = translate(modelText("Complete", false, false, false));

        assertThat(events).hasSize(3);
        assertThat(events.get(0)).isInstanceOf(TextMessageStartEvent.class);
        assertThat(content(events)).containsExactly("Complete");
        assertThat(events.get(2)).isInstanceOf(TextMessageEndEvent.class);
    }

    @Test
    void suppressesUserContent() {
        assertThat(translate(userText("Do not echo"))).isEmpty();
    }

    @Test
    void dropsUserAuthoredEventsBeforeLaterTranslationSteps() {
        Event userToolCall = Event.builder().author("user")
                .content(Content.builder().role("user").parts(Part.builder()
                        .functionCall(FunctionCall.builder().id("user-call").name("weather")
                                .args(java.util.Map.of("city", "Paris")).build()).build()).build())
                .build();

        assertThat(translate(userToolCall)).isEmpty();
    }

    @Test
    void assignsDifferentIdsToSeparateAssistantMessages() {
        List<com.agui.community.core.event.Event> events = translate(
                modelText("First", false, false, false),
                modelText("Second", false, false, false));

        assertThat(events).filteredOn(TextMessageStartEvent.class::isInstance)
                .extracting(event -> ((TextMessageStartEvent) event).messageId())
                .containsExactly( ((TextMessageStartEvent) events.get(0)).messageId(),
                        ((TextMessageStartEvent) events.get(3)).messageId())
                .doesNotHaveDuplicates();
    }

    @Test
    void closesAnOpenTextStreamWhenUpstreamCompletes() {
        List<com.agui.community.core.event.Event> events = translate(modelText("unfinished", true, false, false));

        assertThat(events).hasSize(3);
        assertThat(events.get(2)).isInstanceOf(TextMessageEndEvent.class);
    }

    @Test
    void closesAnOpenTextStreamBeforePropagatingAnUpstreamFailure() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");

        List<io.reactivex.rxjava3.core.Notification<com.agui.community.core.event.Event>> signals = Flowable
                .fromPublisher(translator.apply(Flowable.concatArray(
                        Flowable.just(modelText("unfinished", true, false, false)),
                        Flowable.error(new IllegalStateException("upstream failure")))))
                .materialize()
                .toList()
                .blockingGet();

        assertThat(signals).hasSize(4);
        assertThat(signals.get(1).getValue()).isInstanceOf(TextMessageContentEvent.class);
        assertThat(signals.get(2).getValue()).isInstanceOf(TextMessageEndEvent.class);
        assertThat(signals.get(3).getError()).isInstanceOf(IllegalStateException.class)
                .hasMessage("upstream failure");
    }

    @Test
    void closesTextBeforeFlushingRetainedPartialToolsOnNormalCompletion() {
        List<com.agui.community.core.event.Event> events = translate(
                partialToolCall("weather-1", "weather"), modelText("Thinking", true, false, false));

        assertThat(events.indexOf(events.stream().filter(TextMessageEndEvent.class::isInstance).findFirst().orElseThrow()))
                .isLessThan(events.indexOf(events.stream().filter(ToolCallStartEvent.class::isInstance).findFirst().orElseThrow()));
    }

    @Test
    void emitsOnlyTheUnseenFinalAggregateSuffixForAnOpenStream() {
        List<com.agui.community.core.event.Event> events = translate(
                modelText("Hello ", true, false, false), modelText("Hello world", false, true, true));

        assertThat(events).extracting(Object::getClass).containsExactly(
                TextMessageStartEvent.class, TextMessageContentEvent.class,
                TextMessageContentEvent.class, TextMessageEndEvent.class);
        assertThat(content(events)).containsExactly("Hello ", "world");
    }

    @Test
    void emitsAnIdenticalLaterCompleteAssistantMessage() {
        List<com.agui.community.core.event.Event> events = translate(
                modelText("Same", true, false, false), modelText("Same", false, true, true),
                modelText("Same", false, false, false));

        assertThat(events).filteredOn(TextMessageContentEvent.class::isInstance)
                .extracting(event -> ((TextMessageContentEvent) event).delta())
                .containsExactly("Same", "Same");
    }

    @Test
    void emitsALaterCompleteAssistantMessageThatIsASuffixOfThePreviousMessage() {
        List<com.agui.community.core.event.Event> events = translate(
                modelText("A longer message", true, false, false),
                modelText("A longer message", false, true, true), modelText("message", false, false, false));

        assertThat(events).filteredOn(TextMessageContentEvent.class::isInstance)
                .extracting(event -> ((TextMessageContentEvent) event).delta())
                .containsExactly("A longer message", "message");
    }


    @Test
    void finalResponseWithEmptyTextClosesAnActiveStream() {
        // Stream is open from the partial delta, then an empty final response must still
        // close it with TEXT_MESSAGE_END (Python L594-625).
        List<com.agui.community.core.event.Event> events = translate(
                modelText("Thinking", true, false, false),
                finalResponseWithEmptyText());

        assertThat(events).extracting(Object::getClass).containsExactly(
                TextMessageStartEvent.class, TextMessageContentEvent.class, TextMessageEndEvent.class);
    }

    @Test
    void finishReasonClosesAnActiveStream() {
        List<com.agui.community.core.event.Event> events = translate(
                modelText("partial", true, false, false),
                Event.builder().author("model").partial(true)
                        .finishReason(new com.google.genai.types.FinishReason(com.google.genai.types.FinishReason.Known.STOP))
                        .content(Content.builder().role("model").parts(Part.fromText("")).build()).build());

        assertThat(events).filteredOn(TextMessageEndEvent.class::isInstance).hasSize(1);
    }

    @Test
    void suffixMatchSuppressesAnAlreadyStreamedAggregate() {
        // _last_streamed_text.endswith(combined_text): after a stream of "Hello world" closes,
        // a later final aggregate "world" is a suffix of the already-streamed text and must not
        // be emitted again (GitHub #400, Python _translate_text_content).
        List<com.agui.community.core.event.Event> events = translate(
                modelText("Hello ", true, false, false),
                modelText("world", true, false, false),
                modelText("Hello world", false, true, true));

        assertThat(events).filteredOn(TextMessageContentEvent.class::isInstance)
                .extracting(event -> ((TextMessageContentEvent) event).delta())
                .containsExactly("Hello ", "world");
        assertThat(events).filteredOn(TextMessageEndEvent.class::isInstance).hasSize(1);
    }

    @Test
    void suppressesTextFromOutputSchemaAgents() {
        List<com.agui.community.core.event.Event> events = translateWithOutputSchema(
                "classifier", authoredText("classifier", "CHAT", false, false, false));

        assertThat(events).isEmpty();
    }

    @Test
    void suppressesStreamedDeltasFromOutputSchemaAgents() {
        List<com.agui.community.core.event.Event> events = translateWithOutputSchema(
                "classifier", authoredText("classifier", "CH", true, false, false), authoredText("classifier", "AT", true, false, false));

        assertThat(events).isEmpty();
    }

    @Test
    void outputSchemaSuppressionDoesNotAffectOtherAgents() {
        List<com.agui.community.core.event.Event> events = translateWithOutputSchema(
                "classifier", modelText("user-visible", true, true, true));

        assertThat(events).filteredOn(TextMessageContentEvent.class::isInstance).hasSize(1);
        assertThat(events).filteredOn(TextMessageEndEvent.class::isInstance).hasSize(1);
    }

    private static List<com.agui.community.core.event.Event> translateWithOutputSchema(
            String outputSchemaAgent, Event... events) {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create(
                "thread", "run", List.of(), new java.util.HashSet<>(List.of(outputSchemaAgent)));
        return Flowable.fromPublisher(translator.apply(Flowable.fromArray(events))).toList().blockingGet();
    }

    private static List<com.agui.community.core.event.Event> translate(Event... events) {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");
        return Flowable.fromPublisher(translator.apply(Flowable.fromArray(events))).toList().blockingGet();
    }

    private static List<String> content(List<com.agui.community.core.event.Event> events) {
        return events.stream().filter(TextMessageContentEvent.class::isInstance)
                .map(TextMessageContentEvent.class::cast).map(TextMessageContentEvent::delta).toList();
    }


    private static Event finalResponseWithEmptyText() {
        return Event.builder().author("model").partial(false).turnComplete(true)
                .content(Content.builder().role("model").parts(Part.fromText("")).build()).build();
    }

    private static Event modelText(String text, boolean partial, boolean finalResponse, boolean turnComplete) {
        return authoredText("model", text, partial, finalResponse, turnComplete);
    }

    /** Builds an assistant text event with a caller-chosen author (for output_schema agents). */
    private static Event authoredText(String author, String text, boolean partial,
                                      boolean finalResponse, boolean turnComplete) {
        return Event.builder().author(author).partial(partial).turnComplete(turnComplete)
                .content(Content.builder().role("model").parts(Part.fromText(text)).build())
                .build();
    }

    private static Event partialToolCall(String id, String name) {
        return Event.builder().author("model").partial(true)
                .content(Content.builder().role("model").parts(Part.builder()
                        .functionCall(FunctionCall.builder().id(id).name(name).args(java.util.Map.of()).build()).build()).build())
                .build();
    }

    private static Event userText(String text) {
        return Event.builder().author("user")
                .content(Content.builder().role("user").parts(Part.fromText(text)).build())
                .build();
    }
}
