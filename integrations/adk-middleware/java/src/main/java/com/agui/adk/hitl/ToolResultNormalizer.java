package com.agui.adk.hitl;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.agui.community.core.message.ToolMessage;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Converts every official frontend tool-result representation without dropping JSON values. */
public final class ToolResultNormalizer {
    private static final ObjectMapper JSON = new ObjectMapper()
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true))
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .enable(DeserializationFeature.USE_BIG_INTEGER_FOR_INTS);

    /**
     * Normalizes a result before it is durably submitted to the pending-call store.
     *
     * @param message official frontend tool result
     * @return lossless normalized response
     */
    public NormalizedToolResult normalize(ToolMessage message) {
        Objects.requireNonNull(message, "message");
        Map<String, Object> response = new LinkedHashMap<>();
        if (message.error() != null) {
            response.put("error", message.error());
        } else {
            Object value = parseOrText(message.content());
            if (value instanceof Map<?, ?> object) {
                object.forEach((key, item) -> response.put(String.valueOf(key), item));
            } else {
                response.put("result", value);
            }
        }
        return new NormalizedToolResult(message.toolCallId(), response);
    }

    /**
     * Parses JSON when possible and retains malformed input as original text.
     *
     * @param content frontend payload text
     * @return JSON value or original text
     */
    private static Object parseOrText(String content) {
        String value = content == null ? "" : content;
        try {
            JsonNode node = JSON.readTree(value);
            if (node == null || node.isMissingNode()) {
                return value;
            }
            return jsonValue(node);
        } catch (Exception ignored) {
            return value;
        }
    }

    /**
     * Converts a parsed JSON tree to only exact Java representations.
     *
     * @param node parsed JSON value
     * @return exact Java representation
     */
    private static Object jsonValue(JsonNode node) {
        if (node.isObject()) {
            Map<String, Object> object = new LinkedHashMap<>();
            node.properties().forEach(entry -> object.put(entry.getKey(), jsonValue(entry.getValue())));
            return object;
        }
        if (node.isArray()) {
            List<Object> array = new ArrayList<>();
            node.forEach(item -> array.add(jsonValue(item)));
            return array;
        }
        if (node.isIntegralNumber()) {
            if (node.canConvertToInt()) {
                return node.intValue();
            }
            if (node.canConvertToLong()) {
                return node.longValue();
            }
            return node.bigIntegerValue();
        }
        if (node.isFloatingPointNumber()) {
            return node.decimalValue();
        }
        if (node.isTextual()) {
            return node.textValue();
        }
        if (node.isBoolean()) {
            return node.booleanValue();
        }
        if (node.isNull()) {
            return null;
        }
        throw new IllegalArgumentException("unsupported JSON value");
    }
}
