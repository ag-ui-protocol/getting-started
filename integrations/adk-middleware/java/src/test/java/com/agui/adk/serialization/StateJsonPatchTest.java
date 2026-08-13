package com.agui.adk.serialization;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class StateJsonPatchTest {

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void convertStateToJsonPatchUsesReplaceForNonNullAndRemoveForNull() {
        Map<String, Object> d1 = map("a", "1", "b", null, "c", map("x", 1));
        List<Map<String, Object>> patches = StateJsonPatch.convertStateToJsonPatch(d1);
        assertThat(patches).containsExactly(
                map("op", "replace", "path", "/a", "value", "1"),
                map("op", "remove", "path", "/b"),
                map("op", "replace", "path", "/c", "value", map("x", 1)));
    }

    @Test
    void convertJsonPatchToStateReversesOpsAndIgnoresOthers() {
        List<Map<String, Object>> p2 = List.of(
                map("op", "remove", "path", "/b"),
                map("op", "replace", "path", "/a", "value", "2"),
                map("op", "add", "path", "/c", "value", 3),
                map("op", "test", "path", "/x", "value", 1),
                map("op", "remove", "path", "//z"));
        assertThat(StateJsonPatch.convertJsonPatchToState(p2))
                .isEqualTo(map("b", null, "a", "2", "c", 3, "z", null));
    }

    @Test
    void roundTripsForwardAndBack() {
        Map<String, Object> d = map("x", "1", "y", null);
        assertThat(StateJsonPatch.convertJsonPatchToState(
                StateJsonPatch.convertStateToJsonPatch(d))).isEqualTo(d);
    }

    @Test
    void nullishInputsYieldEmptyResults() {
        assertThat(StateJsonPatch.convertStateToJsonPatch(null)).isEmpty();
        assertThat(StateJsonPatch.convertJsonPatchToState(null)).isEmpty();
    }
}
