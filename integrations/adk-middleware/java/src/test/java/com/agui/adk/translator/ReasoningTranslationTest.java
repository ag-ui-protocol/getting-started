package com.agui.adk.translator;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import com.agui.community.core.event.ReasoningEncryptedValueEvent;
import com.agui.community.core.event.ReasoningEndEvent;
import com.agui.community.core.event.ReasoningMessageContentEvent;
import com.agui.community.core.event.ReasoningMessageEndEvent;
import com.agui.community.core.event.ReasoningMessageStartEvent;
import com.agui.community.core.event.ReasoningStartEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ReasoningTranslationTest {
    @Test
    void keepsSameIdPartialAndFinalThoughtsInOneReasoningLifecycleWithoutAggregateDuplication() {
        Event partial = Event.builder().id("thought-7").author("model").partial(true).content(Content.builder().parts(
                Part.builder().text("plan ").thought(true).build(),
                Part.builder().text("steps").thought(true).build()).build()).build();
        Event finalEvent = Event.builder().id("thought-7").author("model").content(Content.builder().parts(
                Part.builder().text("plan ").thought(true).build(),
                Part.builder().text("steps").thought(true).build(),
                Part.builder().text(" done").thought(true).build(), Part.fromText("answer")).build()).build();

        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run")
                        .apply(io.reactivex.rxjava3.core.Flowable.just(partial, finalEvent))).toList().blockingGet();

        assertThat(events.subList(0, 6)).containsExactly(
                new ReasoningStartEvent("thought-7"), new ReasoningMessageStartEvent("thought-7"),
                new ReasoningMessageContentEvent("thought-7", "plan steps"),
                new ReasoningMessageContentEvent("thought-7", " done"),
                new ReasoningMessageEndEvent("thought-7"), new ReasoningEndEvent("thought-7"));
        assertThat(events.subList(6, 9)).extracting(Object::getClass).containsExactly(
                TextMessageStartEvent.class, com.agui.community.core.event.TextMessageContentEvent.class,
                com.agui.community.core.event.TextMessageEndEvent.class);
    }

    @Test
    void keepsDifferentProviderEventIdsInOneOpenReasoningLifecycle() {
        Event first = Event.builder().id("provider-chunk-1").author("model").partial(true)
                .content(Content.builder().parts(Part.builder().text("plan ").thought(true).build()).build()).build();
        Event second = Event.builder().id("provider-chunk-2").author("model").partial(true)
                .content(Content.builder().parts(Part.builder().text("steps").thought(true)
                        .thoughtSignature("second-signature".getBytes(StandardCharsets.UTF_8)).build()).build()).build();
        Event complete = Event.builder().id("provider-complete").author("model")
                .content(Content.builder().parts(Part.builder().text(" done").thought(true).build()).build()).build();

        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run")
                        .apply(io.reactivex.rxjava3.core.Flowable.just(first, second, complete)))
                .toList().blockingGet();

        assertThat(events).containsExactly(
                new ReasoningStartEvent("provider-chunk-1"),
                new ReasoningMessageStartEvent("provider-chunk-1"),
                new ReasoningMessageContentEvent("provider-chunk-1", "plan "),
                new ReasoningMessageContentEvent("provider-chunk-1", "steps"),
                new ReasoningEncryptedValueEvent("message", "provider-chunk-1", "c2Vjb25kLXNpZ25hdHVyZQ=="),
                new ReasoningMessageContentEvent("provider-chunk-1", " done"),
                new ReasoningMessageEndEvent("provider-chunk-1"),
                new ReasoningEndEvent("provider-chunk-1"));
    }

    @Test
    void nonPartialThoughtStaysOpenUntilVisibleTextTransition() {
        Event thought = Event.builder().id("reasoning-open").author("model").content(Content.builder().parts(
                Part.builder().text("internal").thought(true).build()).build()).build();
        Event signature = Event.builder().id("provider-signature").author("model").content(Content.builder().parts(
                Part.builder().thought(true).thoughtSignature(
                        "later".getBytes(StandardCharsets.UTF_8)).build()).build()).build();
        Event visible = Event.builder().author("model").content(Content.builder().parts(
                Part.fromText("answer")).build()).build();
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");

        List<com.agui.community.core.event.Event> thoughtEvents = new java.util.ArrayList<>(
                translator.translate(thought).toList().blockingGet());
        thoughtEvents.addAll(translator.translate(signature).toList().blockingGet());
        List<com.agui.community.core.event.Event> visibleEvents = translator.translate(visible).toList().blockingGet();

        assertThat(thoughtEvents).containsExactly(
                new ReasoningStartEvent("reasoning-open"),
                new ReasoningMessageStartEvent("reasoning-open"),
                new ReasoningMessageContentEvent("reasoning-open", "internal"),
                new ReasoningEncryptedValueEvent("message", "reasoning-open", "bGF0ZXI="));
        assertThat(visibleEvents.subList(0, 2)).containsExactly(
                new ReasoningMessageEndEvent("reasoning-open"),
                new ReasoningEndEvent("reasoning-open"));
        assertThat(visibleEvents.subList(2, 5)).extracting(Object::getClass).containsExactly(
                TextMessageStartEvent.class, com.agui.community.core.event.TextMessageContentEvent.class,
                com.agui.community.core.event.TextMessageEndEvent.class);
    }

    @Test
    void translatesThoughtWithSignatureBeforeVisibleTextUsingOneStableId() {
        Event event = Event.builder().id("reasoning-42").author("model").content(Content.builder().parts(
                Part.builder().text("internal").thought(true)
                        .thoughtSignature("encrypted".getBytes(StandardCharsets.UTF_8)).build(),
                Part.fromText("visible")).build()).build();

        List<com.agui.community.core.event.Event> events = io.reactivex.rxjava3.core.Flowable.fromPublisher(
                EventTranslatorFactory.INSTANCE.create("thread", "run")
                        .apply(io.reactivex.rxjava3.core.Flowable.just(event))).toList().blockingGet();

        assertThat(events).hasSize(9);
        assertThat(events.get(0)).isEqualTo(new ReasoningStartEvent("reasoning-42"));
        assertThat(events.get(1)).isEqualTo(new ReasoningMessageStartEvent("reasoning-42"));
        assertThat(events.get(2)).isEqualTo(new ReasoningMessageContentEvent("reasoning-42", "internal"));
        assertThat(events.get(3)).isInstanceOf(ReasoningEncryptedValueEvent.class);
        ReasoningEncryptedValueEvent signature = (ReasoningEncryptedValueEvent) events.get(3);
        assertThat(signature.entityId()).isEqualTo("reasoning-42");
        assertThat(signature.subtype()).isEqualTo("message");
        assertThat(signature.encryptedValue()).isEqualTo("ZW5jcnlwdGVk");
        assertThat(events.get(4)).isEqualTo(new ReasoningMessageEndEvent("reasoning-42"));
        assertThat(events.get(5)).isEqualTo(new ReasoningEndEvent("reasoning-42"));
        assertThat(events.get(6)).isInstanceOf(TextMessageStartEvent.class);
    }
}
