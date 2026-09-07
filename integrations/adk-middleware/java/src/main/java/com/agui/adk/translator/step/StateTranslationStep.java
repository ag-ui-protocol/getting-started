package com.agui.adk.translator.step;

import com.google.adk.events.Event;
import com.agui.adk.state.StateProjector;
import com.agui.adk.translator.TranslationContext;
import com.agui.community.core.event.JsonPatchOperation;
import com.agui.community.core.event.StateDeltaEvent;
import io.reactivex.rxjava3.core.Flowable;

import java.util.List;
import java.util.Map;

/** Emits client-safe JSON Patch deltas while retaining their canonical snapshot. */
public enum StateTranslationStep implements EventTranslationStep {
    INSTANCE;

    @Override
    public Flowable<com.agui.community.core.event.Event> translate(Event event, TranslationContext context) {
        Map<String, Object> delta = event.actions().stateDelta();
        if (delta == null || delta.isEmpty()) {
            return Flowable.empty();
        }
        List<JsonPatchOperation> patches = delta.entrySet().stream()
                .filter(entry -> !entry.getKey().startsWith("temp:"))
                .map(StateTranslationStep::patch).toList();
        context.applyStateDelta(delta);
        if (patches.isEmpty()) {
            return Flowable.empty();
        }
        return Flowable.just(new StateDeltaEvent(patches));
    }

    /**
     * Converts one ADK state entry to a JSON Patch operation.
     *
     * @param entry ADK state entry
     * @return equivalent client-safe patch
     */
    private static JsonPatchOperation patch(Map.Entry<String, Object> entry) {
        String path = "/" + entry.getKey();
        return new JsonPatchOperation("add", path, StateProjector.defensiveCopy(entry.getValue()));
    }
}
