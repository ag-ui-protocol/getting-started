package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.google.adk.events.Event;
import io.reactivex.rxjava3.core.Flowable;

/**
 * The high-level component interface for a step in the event translation process.
 */
@FunctionalInterface
public interface EventTranslationStep {
    /**
     * Translates an ADK Event.
     * @param event The incoming ADK Event.
     * @param context The shared context for the translation stream.
     * @return A Flowable stream of BaseEvents.
     */
    Flowable<com.agui.community.core.event.Event> translate(Event event, TranslationContext context);
}
