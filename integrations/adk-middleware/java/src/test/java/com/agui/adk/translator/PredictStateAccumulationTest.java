package com.agui.adk.translator;

import static org.assertj.core.api.Assertions.assertThat;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.community.core.event.StateSnapshotEvent;
import io.reactivex.rxjava3.core.Flowable;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * P1 #14 — Predict-state accumulation from tool arguments merged into the final STATE_SNAPSHOT,
 * ported from {@code ClientProxyTool} / {@code ClientProxyToolset.get_accumulated_predict_state}
 * ({@code client_proxy_tool.py}, {@code client_proxy_toolset.py} L144): values are derived from
 * the invoked tool arguments (the value at {@code tool_argument}, or the whole args when empty)
 * and captured under {@code state_key} so they survive the final snapshot.
 */
class PredictStateAccumulationTest {

    private static Event call(String id, String name, Map<String, Object> args) {
        return Event.builder().author("model").partial(false)
                .content(Content.builder().role("model")
                        .parts(List.of(Part.builder()
                                .functionCall(FunctionCall.builder().name(name).args(args).build())
                                .build()))
                        .build())
                .build();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> snapshot(EventTranslator translator, Event... events) {
        List<com.agui.community.core.event.Event> out =
                Flowable.fromPublisher(translator.apply(Flowable.fromArray(events))).toList().blockingGet();
        return out.stream()
                .filter(StateSnapshotEvent.class::isInstance)
                .map(e -> (Map<String, Object>) ((StateSnapshotEvent) e).snapshot())
                .findFirst()
                .orElse(Map.of());
    }

    @Test
    void accumulatesToolArgumentValueIntoFinalSnapshot() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run",
                List.of(new PredictStateMapping("weather", false, "predictedCity", "city",
                        Map.of("status", (Object) "loading"))));

        Map<String, Object> state = snapshot(translator, call("provider-1", "weather", Map.of("city", "Paris")));

        assertThat(state).containsEntry("predictedCity", "Paris");
    }

    @Test
    void accumulatesWholeArgsWhenNoToolArgument() {
        // An empty tool_argument captures the entire invocation args under state_key.
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run",
                List.of(new PredictStateMapping("weather", false, "lastWeatherArgs", "",
                        Map.of("status", (Object) "loading"))));

        Map<String, Object> state = snapshot(translator, call("provider-1", "weather", Map.of("city", "Paris")));

        assertThat(state).containsKey("lastWeatherArgs");
        assertThat(state.get("lastWeatherArgs")).isEqualTo(Map.of("city", (Object) "Paris"));
    }

    @Test
    void missingToolArgumentDoesNotAccumulate() {
        EventTranslator translator = EventTranslatorFactory.INSTANCE.create("thread", "run",
                List.of(new PredictStateMapping("weather", false, "predictedCity", "city",
                        Map.of("status", (Object) "loading"))));

        // The call has no "city" argument (different key) -> nothing accumulated under state_key.
        Map<String, Object> state = snapshot(translator, call("provider-1", "weather", Map.of("other", "x")));

        assertThat(state).doesNotContainKey("predictedCity");
    }

    @Test
    void legacyThreeArgMappingStillCreatesValidPredictiveEvent() {
        // The pre-parity 3-arg constructor remains valid (state_key/tool_argument null).
        PredictStateMapping mapping = new PredictStateMapping("weather", false, Map.of("status", "loading"));
        assertThat(mapping.stateKey()).isNull();
        assertThat(mapping.toolArgument()).isNull();
        assertThat(mapping).isNotNull();
    }
}
