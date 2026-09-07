package com.agui.adk.history;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Pure port of the Python {@code ADKAgent._build_function_response_parts}: converts AG-UI
 * tool-result messages into ADK {@code FunctionResponse} parts, shared by the resume and buffer
 * paths. Applies the client-&gt;ADK LRO id remap, parses each result's content as JSON when
 * possible (a JSON object becomes the response; any other/string/empty content is wrapped in a
 * {@code {success, result, status}} result object) and threads the resolved tool name.
 */
public final class ToolResultResponseBuilder {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Wraps a value as {@code {"success": true, key: value, "status": "completed"}} for the
     * generic function-response envelope (Python's {@code {"success", "result", "status"}} wrapper).
     *
     * @param key the result key (e.g. {@code result})
     * @param value the result value (may be null)
     * @return the wrapped envelope map
     */
    private static Map<String, Object> wrapped(String key, Object value) {
        java.util.LinkedHashMap<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("success", true);
        m.put(key, value);
        m.put("status", "completed");
        return m;
    }

    private ToolResultResponseBuilder() {
    }

    /**
     * Builds the {@code FunctionResponse} parts for the given tool results, applying the LRO id
     * remap to each call id and parsing content per the Python fallback rules.
     *
     * @param toolResults the extracted tool results (name + message)
     * @param lroIdRemap  client-facing to ADK-persisted call-id remap (may be empty)
     * @return the ADK function-response parts
     */
    @SuppressWarnings("unchecked")
    public static List<Part> buildFunctionResponseParts(
            List<ToolResultExtractor.ToolResult> toolResults, Map<String, String> lroIdRemap) {
        List<Part> parts = new ArrayList<>();
        for (ToolResultExtractor.ToolResult tr : toolResults) {
            String toolCallId = tr.message().toolCallId();
            toolCallId = lroIdRemap != null ? lroIdRemap.getOrDefault(toolCallId, toolCallId) : toolCallId;
            String content = tr.message().content();
            Object result;
            if (content != null && !content.isBlank()) {
                Object parsed = null;
                try {
                    parsed = JSON.readValue(content, Object.class);
                } catch (Exception e) {
                    parsed = null; // not valid JSON
                }
                if (parsed instanceof Map<?, ?>) {
                    result = parsed;
                } else if (parsed != null) {
                    // e.g. a JSON list, string, or number: wrap like the string fallback.
                    result = wrapped("result", parsed);
                } else {
                    result = wrapped("result", content);
                }
            } else {
                // Empty content is a success with an empty result.
                result = wrapped("result", null);
            }
            parts.add(Part.builder().functionResponse(FunctionResponse.builder()
                    .id(toolCallId).name(tr.toolName()).response((Map<String, Object>) result).build()).build());
        }
        return parts;
    }
}
