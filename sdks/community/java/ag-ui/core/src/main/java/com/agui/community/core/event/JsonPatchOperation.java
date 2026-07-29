package com.agui.community.core.event;

import java.util.Objects;

/**
 * A single JSON Patch operation as defined by
 * <a href="https://datatracker.ietf.org/doc/html/rfc6902">RFC 6902</a>, used to
 * describe incremental changes in {@link StateDeltaEvent} and
 * {@link ActivityDeltaEvent}.
 *
 * @param op    the operation to perform, e.g. {@code "add"}, {@code "remove"},
 *              {@code "replace"}, {@code "move"}, {@code "copy"} or
 *              {@code "test"} (required)
 * @param path  the JSON Pointer to the target location (required)
 * @param from  the source location for {@code move}/{@code copy} operations, or
 *              {@code null}
 * @param value the value for {@code add}/{@code replace}/{@code test}
 *              operations, or {@code null}
 */
public record JsonPatchOperation(String op, String path, String from, Object value) {

    public JsonPatchOperation {
        Objects.requireNonNull(op, "op must not be null");
        Objects.requireNonNull(path, "path must not be null");
    }

    /**
     * Creates a patch operation without a {@code from} pointer.
     *
     * @param op    the operation to perform
     * @param path  the JSON Pointer to the target location
     * @param value the operation value
     */
    public JsonPatchOperation(String op, String path, Object value) {
        this(op, path, null, value);
    }
}
