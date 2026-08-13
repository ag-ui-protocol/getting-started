package com.agui.adk.session;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.google.adk.sessions.State;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Encodes client-visible state as canonical JSON while preserving bridge-owned session state.
 */
public final class ClientStateStore {

    private static final TypeReference<LinkedHashMap<String, Object>> MAP_TYPE = new TypeReference<>() { };
    private static final Object OMITTED = new Object();

    private final ObjectMapper objectMapper;

    /**
     * Creates a client-state codec.
     *
     * @param objectMapper JSON mapper used for persistence
     */
    public ClientStateStore(ObjectMapper objectMapper) {
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper").copy()
                .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
    }

    /**
     * Adds a protected canonical client-state value without allowing client internal-key writes.
     *
     * @param sessionState existing session state
     * @param clientState client-owned state snapshot
     * @return copied state for ADK persistence
     */
    public Map<String, Object> persistClientState(
            Map<String, Object> sessionState, Map<String, Object> clientState) {
        Map<String, Object> persisted = new LinkedHashMap<>(safeMap(sessionState));
        persisted.put(SessionStateKeys.CLIENT_STATE, canonicalJson(publicEntries(clientState)));
        return java.util.Collections.unmodifiableMap(persisted);
    }

    /**
     * Reads a client-visible snapshot from protected session storage.
     *
     * @param sessionState ADK state
     * @return client-visible state only
     */
    public Map<String, Object> snapshot(Map<String, Object> sessionState) {
        Object stored = safeMap(sessionState).get(SessionStateKeys.CLIENT_STATE);
        if (!(stored instanceof String json)) {
            return Map.of();
        }
        try {
            return java.util.Collections.unmodifiableMap(
                    publicEntries(objectMapper.readValue(json, MAP_TYPE)));
        } catch (Exception error) {
            throw new IllegalStateException("Invalid persisted AG-UI client state", error);
        }
    }

    /**
     * Builds a per-invocation context delta. Callers must not append this value to session history.
     *
     * @param state current invocation state delta
     * @param context replacement context for the invocation
     * @return copied delta containing only the latest protected context
     */
    public Map<String, Object> persistContext(
            Map<String, Object> state, Map<String, Object> context) {
        Map<String, Object> delta = new LinkedHashMap<>(safeMap(state));
        delta.put(SessionStateKeys.REQUEST_CONTEXT, canonicalJson(publicEntries(context)));
        return java.util.Collections.unmodifiableMap(delta);
    }

    /**
     * Reads invocation context from a request delta.
     *
     * @param state request delta
     * @return decoded context
     */
    public Map<String, Object> context(Map<String, Object> state) {
        Object stored = safeMap(state).get(SessionStateKeys.REQUEST_CONTEXT);
        if (!(stored instanceof String json)) {
            return Map.of();
        }
        try {
            return java.util.Collections.unmodifiableMap(
                    publicEntries(objectMapper.readValue(json, MAP_TYPE)));
        } catch (Exception error) {
            throw new IllegalStateException("Invalid AG-UI request context", error);
        }
    }

    /**
     * Normalizes string collections persisted by heterogeneous session services.
     *
     * @param sessionState session state
     * @param key collection key
     * @return valid string values
     */
    public Set<String> stringSet(Map<String, Object> sessionState, String key) {
        Object value = safeMap(sessionState).get(key);
        if (value instanceof String json && json.startsWith("[")) {
            try {
                value = objectMapper.readValue(json, new TypeReference<Collection<Object>>() { });
            } catch (Exception error) {
                return Set.of();
            }
        }
        if (value instanceof Collection<?> collection) {
            Set<String> values = new LinkedHashSet<>();
            collection.stream().filter(String.class::isInstance).map(String.class::cast).forEach(values::add);
            return Set.copyOf(values);
        }
        if (value != null && value.getClass().isArray()) {
            Set<String> values = new LinkedHashSet<>();
            int length = java.lang.reflect.Array.getLength(value);
            for (int index = 0; index < length; index++) {
                Object item = java.lang.reflect.Array.get(value, index);
                if (item instanceof String string) {
                    values.add(string);
                }
            }
            return Set.copyOf(values);
        }
        return Set.of();
    }

    /**
     * Serializes values with deterministic object-key ordering.
     *
     * @param values values to encode
     * @return canonical JSON object
     */
    private String canonicalJson(Map<String, Object> values) {
        try {
            return objectMapper.writeValueAsString(values);
        } catch (Exception error) {
            throw new IllegalArgumentException("Unable to serialize AG-UI client state", error);
        }
    }

    /**
     * Removes bridge-owned keys from a client-controlled object.
     *
     * @param source candidate client values
     * @return public values only
     */
    private static Map<String, Object> publicEntries(Map<String, Object> source) {
        return publicMap(safeMap(source));
    }

    /**
     * Removes bridge metadata and ADK removal sentinels without changing JSON null values.
     *
     * <p>ADK stores a top-level null in {@link State} as {@link State#REMOVED}. The sentinel
     * means deletion, while a Java null is a JSON null that must survive canonical encoding.
     *
     * @param source candidate client entries
     * @return public canonical entries
     */
    private static Map<String, Object> publicMap(Map<?, ?> source) {
        Map<String, Object> entries = new LinkedHashMap<>();
        source.forEach((key, value) -> {
            if (key instanceof String stringKey && !SessionStateKeys.isProtected(stringKey)) {
                Object publicValue = publicValue(value);
                if (publicValue != OMITTED) {
                    entries.put(stringKey, publicValue);
                }
            }
        });
        return entries;
    }

    /**
     * Converts one client value while omitting ADK removal sentinels.
     *
     * @param value candidate client value
     * @return public value or the internal omission marker
     */
    private static Object publicValue(Object value) {
        if (value == State.REMOVED) {
            return OMITTED;
        }
        if (value instanceof Map<?, ?> map) {
            return publicMap(map);
        }
        if (value instanceof Collection<?> collection) {
            List<Object> values = new ArrayList<>();
            collection.forEach(item -> {
                Object publicItem = publicValue(item);
                if (publicItem != OMITTED) {
                    values.add(publicItem);
                }
            });
            return values;
        }
        if (value != null && value.getClass().isArray()) {
            List<Object> values = new ArrayList<>();
            int length = java.lang.reflect.Array.getLength(value);
            for (int index = 0; index < length; index++) {
                Object publicItem = publicValue(java.lang.reflect.Array.get(value, index));
                if (publicItem != OMITTED) {
                    values.add(publicItem);
                }
            }
            return values;
        }
        return value;
    }

    private static Map<String, Object> safeMap(Map<String, Object> values) {
        return values == null ? Map.of() : values;
    }
}
