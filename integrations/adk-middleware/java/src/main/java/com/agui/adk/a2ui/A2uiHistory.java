package com.agui.adk.a2ui;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Prior-surface lookup over AG-UI message history (port of the toolkit's {@code find_prior_surface}
 * in {@code ag_ui_a2ui_toolkit/__init__.py}).
 *
 * <p>Walks backwards over tool messages whose content is a JSON string containing
 * {@code a2ui_operations} for the given surface, accumulating the most recent value of each field
 * ({@code components}, {@code data}, {@code catalogId}) across the walk. A late-turn message that
 * only emits {@code updateDataModel} no longer blanks the components/catalogId established by an
 * earlier turn — the function returns the surface's <em>latest known state</em>. A message whose
 * end state deletes the surface returns {@code null} (the surface no longer exists).
 */
public final class A2uiHistory {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String A2UI_OPERATIONS_KEY = "a2ui_operations";

    private A2uiHistory() {
    }

    /**
     * Locates the most recent rendered state for {@code surfaceId} in message history.
     *
     * @param messages  AG-UI message history (already normalized to canonical envelope JSON by
     *                  {@link A2uiOperations#normalizeA2uiToolResults})
     * @param surfaceId the surface id to find
     * @return the reconstructed {@code {"components": [...], "data": ..., "catalogId": ...}} map, or
     *         {@code null} when no matching surface is found anywhere in history
     */
    public static Map<String, Object> findPriorSurface(List<? extends Message> messages, String surfaceId) {
        SurfaceState latest = new SurfaceState();
        for (int index = messages.size() - 1; index >= 0; index--) {
            MessageSurfaceState messageState = surfaceState(messages.get(index), surfaceId);
            if (!messageState.mentionsSurface()) {
                continue;
            }
            if (!latest.matched() && messageState.deleted()) {
                return null;
            }
            latest.merge(messageState);
            if (latest.complete()) {
                return latest.toPriorSurface();
            }
        }
        return latest.matched() ? latest.toPriorSurface() : null;
    }

    /**
     * Extracts one message's final state for the requested surface.
     *
     * @param message source history message
     * @param surfaceId requested surface identifier
     * @return the message-local surface state
     */
    private static MessageSurfaceState surfaceState(Message message, String surfaceId) {
        List<?> operations = operations(message);
        if (operations == null) {
            return MessageSurfaceState.unmentioned();
        }
        MessageSurfaceState state = new MessageSurfaceState();
        for (Object operationValue : operations) {
            if (operationValue instanceof Map<?, ?> operation) {
                state.apply(operation, surfaceId);
            }
        }
        return state;
    }

    /**
     * Parses the operation list from a tool message.
     *
     * @param message source history message
     * @return the operation list, or null when unavailable
     */
    private static List<?> operations(Message message) {
        if (!(message instanceof ToolMessage) || message.content() == null) {
            return null;
        }
        try {
            Object parsed = JSON.readValue(message.content(), Object.class);
            if (parsed instanceof Map<?, ?> envelope
                    && envelope.get(A2UI_OPERATIONS_KEY) instanceof List<?> operations) {
                return operations;
            }
        } catch (JsonProcessingException ignored) {
            // Malformed historical tool results cannot contribute prior surface state.
        }
        return null;
    }

    /**
     * Returns an operation payload when it targets the requested surface.
     *
     * @param operation operation envelope
     * @param key payload key
     * @param surfaceId requested surface identifier
     * @return matching payload, or null
     */
    private static Map<?, ?> payload(Map<?, ?> operation, String key, String surfaceId) {
        Object value = operation.get(key);
        return value instanceof Map<?, ?> map && surfaceId.equals(map.get("surfaceId")) ? map : null;
    }

    /**
     * Builds the public prior-surface map from accumulated fields.
     *
     * @param components latest component list
     * @param data latest data model
     * @param catalogId latest catalog identifier
     * @return prior-surface map
     */
    private static Map<String, Object> prior(Object components, Object data, Object catalogId) {
        Map<String, Object> prior = new LinkedHashMap<>();
        prior.put("components", components);
        if (data != null) {
            prior.put("data", data);
        }
        if (catalogId != null) {
            prior.put("catalogId", catalogId);
        }
        return prior;
    }

    /** Mutable end state reconstructed from one message's ordered operations. */
    private static final class MessageSurfaceState {
        private boolean mentionsSurface;
        private boolean deleted;
        private Object catalogId;
        private Object components;
        private Object data;
        private boolean dataSeen;

        private static MessageSurfaceState unmentioned() {
            return new MessageSurfaceState();
        }

        /**
         * Applies one operation when it targets the requested surface.
         *
         * @param operation operation envelope
         * @param surfaceId requested surface identifier
         */
        private void apply(Map<?, ?> operation, String surfaceId) {
            Map<?, ?> delete = payload(operation, "deleteSurface", surfaceId);
            if (delete != null) {
                clearAsDeleted();
                return;
            }
            Map<?, ?> create = payload(operation, "createSurface", surfaceId);
            if (create != null) {
                markPresent();
                if (create.get("catalogId") instanceof String value) {
                    catalogId = value;
                }
            }
            Map<?, ?> componentUpdate = payload(operation, "updateComponents", surfaceId);
            if (componentUpdate != null) {
                markPresent();
                if (componentUpdate.get("components") instanceof List<?> values) {
                    components = values;
                }
            }
            Map<?, ?> dataUpdate = payload(operation, "updateDataModel", surfaceId);
            if (dataUpdate != null) {
                markPresent();
                data = dataUpdate.get("value");
                dataSeen = true;
            }
        }

        /** Resets all fields after a delete operation. */
        private void clearAsDeleted() {
            mentionsSurface = true;
            deleted = true;
            catalogId = null;
            components = null;
            data = null;
            dataSeen = false;
        }

        /** Marks the surface as present after a create or update operation. */
        private void markPresent() {
            mentionsSurface = true;
            deleted = false;
        }

        private boolean mentionsSurface() {
            return mentionsSurface;
        }

        private boolean deleted() {
            return deleted;
        }
    }

    /** Latest-known surface fields accumulated while walking history backwards. */
    private static final class SurfaceState {
        private boolean matched;
        private Object catalogId;
        private Object components;
        private Object data;
        private boolean dataSeen;

        /**
         * Merges an older message without overriding fields already known from newer history.
         *
         * @param messageState older message-local state
         */
        private void merge(MessageSurfaceState messageState) {
            if (!matched) {
                matched = true;
                catalogId = messageState.catalogId;
                components = messageState.components;
                data = messageState.data;
                dataSeen = messageState.dataSeen;
                return;
            }
            if (messageState.deleted) {
                return;
            }
            if (catalogId == null) {
                catalogId = messageState.catalogId;
            }
            if (components == null) {
                components = messageState.components;
            }
            if (!dataSeen && messageState.dataSeen) {
                data = messageState.data;
                dataSeen = true;
            }
        }

        private boolean matched() {
            return matched;
        }

        private boolean complete() {
            return components != null && catalogId != null && dataSeen;
        }

        private Map<String, Object> toPriorSurface() {
            return prior(components == null ? List.of() : components, data, catalogId);
        }
    }
}
