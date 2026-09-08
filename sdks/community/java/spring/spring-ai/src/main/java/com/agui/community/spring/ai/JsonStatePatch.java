package com.agui.community.spring.ai;

import com.agui.community.core.event.JsonPatchOperation;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Computes an <a href="https://datatracker.ietf.org/doc/html/rfc6902">RFC 6902</a>
 * JSON Patch describing how to turn one decoded-JSON value ({@code Map}/{@code List}/
 * scalar) into another. Used to express a shared-state change as an AG-UI
 * {@code STATE_DELTA}.
 *
 * <p>Objects are diffed key by key (emitting {@code add}/{@code remove}/{@code replace}).
 * Arrays and scalars are compared by value and replaced wholesale when they differ
 * — a pragmatic choice that keeps the diff simple and predictable.
 */
final class JsonStatePatch {

    private JsonStatePatch() {
    }

    /**
     * @param before the previous state (may be {@code null})
     * @param after  the new state (may be {@code null})
     * @return the patch operations transforming {@code before} into {@code after}
     */
    static List<JsonPatchOperation> diff(Object before, Object after) {
        List<JsonPatchOperation> operations = new ArrayList<>();
        diff("", before, after, operations);
        return operations;
    }

    private static void diff(String path, Object before, Object after, List<JsonPatchOperation> operations) {
        if (Objects.equals(before, after)) {
            return;
        }
        if (before instanceof Map<?, ?> beforeMap && after instanceof Map<?, ?> afterMap) {
            for (Object key : beforeMap.keySet()) {
                if (!afterMap.containsKey(key)) {
                    operations.add(new JsonPatchOperation("remove", path + "/" + escape(key), null));
                }
            }
            for (Map.Entry<?, ?> entry : afterMap.entrySet()) {
                String childPath = path + "/" + escape(entry.getKey());
                if (!beforeMap.containsKey(entry.getKey())) {
                    operations.add(new JsonPatchOperation("add", childPath, entry.getValue()));
                } else {
                    diff(childPath, beforeMap.get(entry.getKey()), entry.getValue(), operations);
                }
            }
        } else {
            // Scalar, array, or a type change: replace the value at this location.
            operations.add(new JsonPatchOperation("replace", path, after));
        }
    }

    private static String escape(Object key) {
        // JSON Pointer escaping (RFC 6901): '~' -> '~0', '/' -> '~1'.
        return String.valueOf(key).replace("~", "~0").replace("/", "~1");
    }
}
