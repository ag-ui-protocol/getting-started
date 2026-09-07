package com.agui.adk.translator;

import com.google.adk.events.Event;
import com.google.genai.types.CustomMetadata;
import com.agui.community.core.event.CustomEvent;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class AdkMetadataTranslationTest {

    @Test
    void forwardsProviderCustomMetadataAsAdkMetadataCustomEvent() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");
        Event event = Event.builder().author("model").customMetadata(List.of(
                CustomMetadata.builder().key("traceId").stringValue("abc").build(),
                CustomMetadata.builder().key("score").numericValue(3.5f).build(),
                CustomMetadata.builder().key("tags").stringListValue(
                        com.google.genai.types.StringList.builder().values(List.of("a", "b")).build()).build()))
                .build();

        List<com.agui.community.core.event.Event> events =
                io.reactivex.rxjava3.core.Flowable.fromPublisher(
                        translator.apply(io.reactivex.rxjava3.core.Flowable.just(event))).toList().blockingGet();

        assertThat(events).filteredOn(CustomEvent.class::isInstance)
                .singleElement()
                .satisfies(e -> {
                    CustomEvent ce = (CustomEvent) e;
                    assertThat(ce.name()).isEqualTo("adk_metadata");
                    assertThat(ce.value()).isEqualTo(Map.of(
                            "traceId", "abc", "score", 3.5f, "tags", List.of("a", "b")));
                });
    }

    @Test
    void emitsNothingWhenProviderCarriesNoCustomMetadata() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run");
        Event event = Event.builder().author("model").build();

        List<com.agui.community.core.event.Event> events =
                io.reactivex.rxjava3.core.Flowable.fromPublisher(
                        translator.apply(io.reactivex.rxjava3.core.Flowable.just(event))).toList().blockingGet();

        assertThat(events).filteredOn(CustomEvent.class::isInstance).isEmpty();
    }
}
