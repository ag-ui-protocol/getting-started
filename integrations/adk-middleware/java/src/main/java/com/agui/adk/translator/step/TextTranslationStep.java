package com.agui.adk.translator.step;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.agui.adk.translator.TranslationContext;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.message.Role;
import io.reactivex.rxjava3.core.Flowable;

/** Translates assistant text with one lifecycle per streamed or complete message. */
public enum TextTranslationStep implements EventTranslationStep {
    INSTANCE;

    @Override
    public Flowable<com.agui.community.core.event.Event> translate(Event event, TranslationContext context) {
        // Suppress user-visible text from output_schema agents: their text is structured
        // inter-agent output (e.g. a classifier returning "CHAT"), not chat content.
        // Reasoning/thought parts are still emitted (GitHub #1390).
        // EXCEPTION: the turn-completing message must always reach the chat UI — the
        // user needs the closing assistant response even when a tool-capable output_schema
        // agent produced it (e.g. after a frontend tool round-trip).
        if (context.isOutputSchemaAgent(event.author())
                && !event.turnComplete().orElse(false)) {
            return Flowable.empty();
        }
        String text = event.content().flatMap(Content::parts)
                .map(parts -> parts.stream().filter(part -> !part.thought().orElse(false))
                        .map(part -> part.text().orElse("")).reduce("", String::concat))
                .orElse("");
        boolean thoughtOnly = event.content().flatMap(Content::parts)
                .map(parts -> parts.stream().anyMatch(part -> part.thought().orElse(false))
                        && parts.stream().filter(part -> !part.thought().orElse(false))
                                .noneMatch(part -> part.text().filter(value -> !value.isEmpty()).isPresent()))
                .orElse(false);
        if (thoughtOnly) {
            return Flowable.empty();
        }
        boolean isFinalResponse = event.finalResponse();
        boolean hasFinishReason = event.finishReason().isPresent();
        // is_final_response is checked *before* the empty-text early return: an empty final
        // response is a valid stream-closing signal and must close any active stream even
        // when there is no new text content (Python L594-625).
        if (isFinalResponse && text.isEmpty()) {
            return ReasoningTranslationStep.closeReasoning(context).concatWith(closeActiveStream(context));
        }
        if (text.isEmpty()) {
            // Diagnostic finish_reason still forces stream closure when a stream is active
            // (Python L672-677), even with no new text.
            if (hasFinishReason && context.isStreaming()) {
                return ReasoningTranslationStep.closeReasoning(context).concatWith(closeActiveStream(context));
            }
            return Flowable.empty();
        }
        Flowable<com.agui.community.core.event.Event> textEvents = event.partial().orElse(false)
                ? emitDelta(text, context) : emitComplete(text, context);
        return ReasoningTranslationStep.closeReasoning(context).concatWith(textEvents);
    }

    /**
     * Closes any active text stream with its end event.
     *
     * @param context translation state
     * @return the streaming close event when a stream is open
     */
    private static Flowable<com.agui.community.core.event.Event> closeActiveStream(TranslationContext context) {
        return context.forceCloseStreamingMessage()
                .<com.agui.community.core.event.Event>map(TextMessageEndEvent::new)
                .map(Flowable::just).orElse(Flowable.empty());
    }

    /**
     * Emits a start and one delta while retaining the aggregate for final deduplication.
     *
     * @param text assistant delta
     * @param context translation state
     * @return canonical text events
     */
    private Flowable<com.agui.community.core.event.Event> emitDelta(String text, TranslationContext context) {
        Flowable<com.agui.community.core.event.Event> start = context.startStreamingIfNeeded()
                .<com.agui.community.core.event.Event>map(id -> new TextMessageStartEvent(id, Role.ASSISTANT))
                .map(Flowable::just).orElse(Flowable.empty());
        Flowable<com.agui.community.core.event.Event> content = context.getStreamingMessageId()
                .<com.agui.community.core.event.Event>map(id -> new TextMessageContentEvent(id, text))
                .map(Flowable::just).orElse(Flowable.empty());
        context.appendToCurrentStreamText(text);
        return start.concatWith(content);
    }

    /**
     * Closes any delta stream and emits only a non-duplicate complete assistant message.
     *
     * @param text aggregate assistant text
     * @param context translation state
     * @return canonical text events
     */
    private Flowable<com.agui.community.core.event.Event> emitComplete(String text, TranslationContext context) {
        String streamedText = context.getCurrentStreamingText();
        if (context.isStreaming() && text.startsWith(streamedText) && text.length() > streamedText.length()) {
            String suffix = text.substring(streamedText.length());
            Flowable<com.agui.community.core.event.Event> content = context.getStreamingMessageId()
                    .<com.agui.community.core.event.Event>map(id -> new TextMessageContentEvent(id, suffix))
                    .map(Flowable::just).orElse(Flowable.empty());
            Flowable<com.agui.community.core.event.Event> close = context.forceCloseStreamingMessage()
                    .<com.agui.community.core.event.Event>map(TextMessageEndEvent::new)
                    .map(Flowable::just).orElse(Flowable.empty());
            context.resetStreamingHistory();
            return content.concatWith(close);
        }
        Flowable<com.agui.community.core.event.Event> close = context.forceCloseStreamingMessage()
                .<com.agui.community.core.event.Event>map(TextMessageEndEvent::new)
                .map(Flowable::just).orElse(Flowable.empty());
        if (context.isDuplicateStream(text)) {
            context.resetStreamingHistory();
            return close;
        }
        String messageId = java.util.UUID.randomUUID().toString();
        return close.concatWith(Flowable.just(
                new TextMessageStartEvent(messageId, Role.ASSISTANT),
                new TextMessageContentEvent(messageId, text),
                new TextMessageEndEvent(messageId)));
    }
}
