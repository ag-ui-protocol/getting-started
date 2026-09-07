package com.agui.adk.state;

import com.google.adk.sessions.State;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class StateProjectorTest {
    @Test
    void projectsUpdatesRemovalsAndPredictiveOverlayWhileFilteringOnlyTempKeys() throws Exception {
        Class<?> projectorType = Class.forName("com.agui.adk.state.StateProjector");
        Object projector = projectorType.getConstructor(Map.class).newInstance(Map.of("existing", "old"));
        Map<String, Object> delta = new LinkedHashMap<>();
        delta.put("existing", State.REMOVED);
        delta.put("next", "value");
        delta.put("_ag_ui_internal", "visible");
        delta.put("temp:requestOnly", "hidden");
        Map<String, Object> snapshot = (Map<String, Object>) projectorType.getMethod("apply", Map.class, Map.class)
                .invoke(projector, delta, Map.of("predicted", true));

        assertThat(snapshot).isEqualTo(Map.of(
                "next", "value", "_ag_ui_internal", "visible", "predicted", true));
    }

    @Test
    void returnsDeeplyDefensiveSnapshots() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("value", "before");
        StateProjector projector = new StateProjector(Map.of("nested", nested));

        nested.put("value", "after");

        assertThat(projector.snapshot()).isEqualTo(Map.of("nested", Map.of("value", "before")));
    }

    @Test
    void retainsNullElementsInDefensiveJsonArrays() {
        StateProjector projector = new StateProjector(Map.of("items", java.util.Arrays.asList("first", null)));

        assertThat(projector.snapshot()).isEqualTo(Map.of("items", java.util.Arrays.asList("first", null)));
    }
}
