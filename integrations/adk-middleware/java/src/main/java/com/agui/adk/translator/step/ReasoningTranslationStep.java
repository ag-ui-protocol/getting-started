package com.agui.adk.translator.step;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import com.agui.adk.translator.TranslationContext;
import com.agui.community.core.event.ReasoningEncryptedValueEvent;
import com.agui.community.core.event.ReasoningEndEvent;
import com.agui.community.core.event.ReasoningMessageContentEvent;
import com.agui.community.core.event.ReasoningMessageEndEvent;
import com.agui.community.core.event.ReasoningMessageStartEvent;
import com.agui.community.core.event.ReasoningStartEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import io.reactivex.rxjava3.core.Flowable;

import java.util.Base64;
import java.util.List;

/** Translates Gemini thought parts to the AG-UI reasoning lifecycle. */
public enum ReasoningTranslationStep implements EventTranslationStep {
    INSTANCE;

    @Override
    public Flowable<com.agui.community.core.event.Event> translate(Event event, TranslationContext context) {
        List<Part> thoughts = event.content().flatMap(Content::parts).orElse(List.of()).stream()
                .filter(part -> part.thought().orElse(false)).toList();
        if (thoughts.isEmpty()) {
            return Flowable.empty();
        }
        String id = context.reasoningId(event.id());
        Flowable<com.agui.community.core.event.Event> closeText = context.forceCloseStreamingMessage()
                .<com.agui.community.core.event.Event>map(TextMessageEndEvent::new)
                .map(Flowable::just).orElse(Flowable.empty());
        Flowable<com.agui.community.core.event.Event> closePrevious = context.hasOpenReasoning(id)
                ? Flowable.empty() : closeReasoning(context);
        Flowable<com.agui.community.core.event.Event> start;
        if (context.hasOpenReasoning(id)) {
            start = Flowable.empty();
        } else {
            context.openReasoning(id);
            start = Flowable.just(new ReasoningStartEvent(id), new ReasoningMessageStartEvent(id));
        }
        String aggregate = thoughts.stream().flatMap(part -> part.text().stream()).collect(java.util.stream.Collectors.joining());
        Flowable<com.agui.community.core.event.Event> text = Flowable.fromIterable(context.appendReasoning(aggregate).stream()
                .<com.agui.community.core.event.Event>map(value -> new ReasoningMessageContentEvent(id, value)).toList());
        Flowable<com.agui.community.core.event.Event> signatures = Flowable.fromIterable(thoughts).concatMap(part ->
                Flowable.fromIterable(part.thoughtSignature().stream()
                        .<com.agui.community.core.event.Event>map(value -> new ReasoningEncryptedValueEvent(
                                "message", id, Base64.getEncoder().encodeToString(value))).toList()));
        Flowable<com.agui.community.core.event.Event> body = text.concatWith(signatures);
        return closeText.concatWith(closePrevious).concatWith(start).concatWith(body);
    }

    /**
     * Emits the canonical message and reasoning closure for the currently open thought.
     *
     * @param context translation state
     * @return closure events when a reasoning lifecycle is open
     */
    public static Flowable<com.agui.community.core.event.Event> closeReasoning(TranslationContext context) {
        return context.forceCloseReasoning()
                .map(id -> List.<com.agui.community.core.event.Event>of(
                        new ReasoningMessageEndEvent(id), new ReasoningEndEvent(id)))
                .map(Flowable::fromIterable).orElse(Flowable.empty());
    }
}
