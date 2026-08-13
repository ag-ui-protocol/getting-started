package com.agui.adk.translator.step;

import com.google.adk.events.Event;
import com.google.genai.types.CustomMetadata;
import com.agui.adk.translator.TranslationContext;
import com.agui.community.core.event.CustomEvent;
import io.reactivex.rxjava3.core.Flowable;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Emits the provider event's custom metadata as an {@code adk_metadata} custom event.
 *
 * <p>Mirrors the Python translator, which forwards {@code adk_event.custom_data} as a
 * {@link CustomEvent} named {@code adk_metadata} so application payloads ride through the
 * AG-UI stream unchanged. Each metadata entry is collapsed to its scalar or list value.
 */
public enum AdkMetadataTranslationStep implements EventTranslationStep {
    INSTANCE;

    @Override
    public Flowable<com.agui.community.core.event.Event> translate(Event event, TranslationContext context) {
        List<CustomMetadata> metadata = event.customMetadata().orElse(List.of());
        if (metadata.isEmpty()) {
            return Flowable.empty();
        }
        Map<String, Object> value = new LinkedHashMap<>();
        for (CustomMetadata entry : metadata) {
            String key = entry.key().orElse(null);
            if (key == null) {
                continue;
            }
            Object resolved = entry.stringValue().orElse(null);
            if (resolved == null) {
                resolved = entry.numericValue().orElse(null);
            }
            if (resolved == null) {
                resolved = entry.stringListValue().flatMap(l -> l.values()).orElse(List.of());
            }
            value.put(key, resolved);
        }
        if (value.isEmpty()) {
            return Flowable.empty();
        }
        return Flowable.just(new CustomEvent("adk_metadata", value));
    }
}
