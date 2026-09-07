package com.agui.adk.hitl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.community.core.event.ToolCallChunkEvent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable persisted frontend call retaining both official data and exact validated JSON.
 *
 * @param key scoped pending-call identity
 * @param event official event retained for later typed handling
 * @param json exact prevalidated serialized event
 * @param status pending lifecycle state
 */
public record PendingToolCall(
        PendingCallKey key,
        ToolCallChunkEvent event,
        String json,
        PendingStatus status) {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Validates key correlation and snapshots the event raw payload for durable ownership. */
    public PendingToolCall {
        key = Objects.requireNonNull(key, "key");
        event = snapshot(Objects.requireNonNull(event, "event"));
        json = Objects.requireNonNull(json, "json");
        status = Objects.requireNonNull(status, "status");
        if (!key.toolCallId().equals(event.toolCallId())) {
            throw new IllegalArgumentException("pending-call key and event tool-call IDs differ");
        }
    }

    /** Copies raw event data through the project JSON codec and freezes the resulting JSON value. */
    private static ToolCallChunkEvent snapshot(ToolCallChunkEvent source) {
        return new ToolCallChunkEvent(
                source.toolCallId(),
                source.toolCallName(),
                source.parentMessageId(),
                source.delta(),
                source.timestamp(),
                snapshotRawEvent(source.rawEvent()));
    }

    /** Returns a detached immutable JSON-compatible raw payload. */
    private static Object snapshotRawEvent(Object source) {
        if (source == null) {
            return null;
        }
        try {
            JsonNode tree = source instanceof JsonNode node ? node.deepCopy() : JSON.valueToTree(source);
            return freeze(JSON.treeToValue(tree, Object.class));
        } catch (RuntimeException | java.io.IOException error) {
            throw new IllegalArgumentException("raw event must be JSON-snapshotable", error);
        }
    }

    /** Recursively prevents retained raw payloads from being mutated after persistence. */
    private static Object freeze(Object source) {
        if (source instanceof Map<?, ?> map) {
            Map<Object, Object> copy = new LinkedHashMap<>();
            map.forEach((key, value) -> copy.put(key, freeze(value)));
            return Collections.unmodifiableMap(copy);
        }
        if (source instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            list.forEach(value -> copy.add(freeze(value)));
            return Collections.unmodifiableList(copy);
        }
        return source;
    }
}
