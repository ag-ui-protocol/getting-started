package com.agui.adk.input;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.adk.session.SessionStateKeys;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Converts the free-form official run state into request defaults for an ADK session. */
public final class RunStateSupport {
    private static final ObjectMapper JSON = new ObjectMapper();

    private RunStateSupport() {
    }

    /**
     * Returns an immutable string-keyed state object.
     *
     * <p>The official field is free-form JSON, while ADK session state is an object. Null means no
     * defaults; arrays, scalars, and non-string-keyed Java maps are rejected before session
     * mutation.
     *
     * @param state official state value
     * @return immutable state defaults
     */
    public static Map<String, Object> asMap(Object state) {
        if (state == null) {
            return Map.of();
        }
        if (state instanceof JsonNode node) {
            if (!node.isObject()) {
                throw RunInputValidator.invalidInput("state must be a JSON object");
            }
            state = JSON.convertValue(node, Object.class);
        }
        if (!(state instanceof Map<?, ?> source)) {
            throw RunInputValidator.invalidInput("state must be a JSON object");
        }
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw RunInputValidator.invalidInput("state must contain only string keys");
            }
            if (SessionStateKeys.isProtected(key)) {
                throw RunInputValidator.invalidInput("state contains protected key " + key);
            }
            copy.put(key, entry.getValue());
        }
        return Collections.unmodifiableMap(copy);
    }
}
