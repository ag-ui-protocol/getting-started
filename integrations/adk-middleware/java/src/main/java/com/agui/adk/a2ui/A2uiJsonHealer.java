package com.agui.adk.a2ui;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Heals and parses Gemini's free-form JSON-string A2UI {@code components}/{@code data} arguments.
 *
 * <p>Port of the SDK-independent {@code heal_json_arg} / {@code parse_and_fix} subset of the
 * Python bridge's {@code a2ui_google_sdk.py} (OSS-158): smart-curly-quote normalization, a
 * trailing-comma autofix pass, and single-JSON-object-to-list wrapping.
 */
public final class A2uiJsonHealer {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Trailing-comma autofix: a comma followed by optional whitespace and a closing bracket. */
    private static final Pattern TRAILING_COMMA =
            Pattern.compile(",(?=\\s*[\\]\\}])");

    private A2uiJsonHealer() { }

    /**
     * Parses a raw JSON string, returning a JSON array. A single JSON object is wrapped in a list.
     * On a hard parse failure a trailing-comma autofix pass is attempted before giving up.
     *
     * @param payload raw JSON string from the model
     * @return parsed JSON array (single objects wrapped)
     * @throws IllegalArgumentException when the payload cannot be parsed
     */
    public static JsonNode parseAndFix(String payload) {
        String normalized = normalizeSmartQuotes(payload);
        try {
            return parse(normalized);
        } catch (RuntimeException initial) {
            String fixed = removeTrailingCommas(normalized);
            return parse(fixed);
        }
    }

    /**
     * Heals and parses a JSON-string argument.
     *
     * @param value raw JSON string from the model
     * @param expect {@code "list"} returns the healed list; {@code "dict"} unwraps a single-element
     *               list back to the object it wrapped
     * @return the healed payload
     * @throws IllegalArgumentException on a hard parse failure or when {@code expect="dict"} but the
     *                                  payload is not a single JSON object
     */
    public static JsonNode healArg(String value, String expect) {
        JsonNode parsed = parseAndFix(value);
        if ("list".equals(expect)) {
            return parsed;
        }
        if (parsed.isArray() && parsed.size() == 1 && parsed.get(0).isObject()) {
            return parsed.get(0);
        }
        if (parsed.isObject()) { // defensive — parseAndFix returns an array
            return parsed;
        }
        throw new IllegalArgumentException("expected a single JSON object");
    }

    /**
     * Parses the payload, wrapping a single JSON object in a list.
     *
     * @param payload normalized JSON string
     * @return parsed JSON array
     */
    private static JsonNode parse(String payload) {
        try {
            JsonNode node = JSON.readTree(payload);
            return node.isArray() ? node : JSON.createArrayNode().add(node);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to parse JSON: " + e.getOriginalMessage());
        }
    }

    /**
     * Replaces smart (curly) quotes with standard straight quotes.
     *
     * @param jsonStr raw JSON string
     * @return normalized JSON string
     */
    private static String normalizeSmartQuotes(String jsonStr) {
        return jsonStr
                .replace("\u201C", "\"")
                .replace("\u201D", "\"")
                .replace("\u2018", "'")
                .replace("\u2019", "'");
    }

    /**
     * Removes trailing commas (a comma followed by optional whitespace and a closing brace).
     *
     * @param jsonStr raw JSON string
     * @return fixed JSON string
     */
    private static String removeTrailingCommas(String jsonStr) {
        return TRAILING_COMMA.matcher(jsonStr).replaceAll("");
    }
}
