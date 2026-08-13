package com.agui.adk.translator;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A configuration record that defines predictive state behavior for a specific tool.
 * This class corresponds to the {@code PredictStateMapping} dataclass from the Python
 * implementation ({@code config.py}): {@code state_key}, {@code tool}, {@code tool_argument},
 * {@code emit_confirm_tool}, {@code stream_tool_call}.
 *
 * @param toolName the name of the tool this mapping applies to
 * @param emitConfirmTool whether to emit a deferred confirm_changes tool call
 * @param stateKey the key in the state object to predict from the tool argument
 * @param toolArgument the argument name of the tool that provides the value (empty = whole args)
 * @param toPayload the payload for the PredictState CustomEvent
 */
public record PredictStateMapping(
        String toolName,
        boolean emitConfirmTool,
        boolean streamToolCall,
        String stateKey,
        String toolArgument,
        Map<String, Object> toPayload) {

    /**
     * Canonical constructor that performs a defensive copy of the toPayload map to ensure deep
     * immutability.
     *
     * @param toolName tool name
     * @param emitConfirmTool whether to emit a deferred confirm_changes tool call
     * @param streamToolCall whether to defer TOOL_CALL_END during streaming FC args
     * @param stateKey the key in the state object to predict from the tool argument
     * @param toolArgument the argument name providing the value (empty = whole args)
     * @param toPayload payload for the PredictState CustomEvent
     */
    public PredictStateMapping(
            String toolName,
            boolean emitConfirmTool,
            boolean streamToolCall,
            String stateKey,
            String toolArgument,
            Map<String, Object> toPayload) {
        this.toolName = toolName;
        this.emitConfirmTool = emitConfirmTool;
        this.streamToolCall = streamToolCall;
        this.stateKey = stateKey;
        this.toolArgument = toolArgument;
        // Defensive copy: create a new HashMap and then make it unmodifiable.
        // This ensures the internal map cannot be modified by external references.
        this.toPayload = (toPayload != null) ? Map.copyOf(toPayload) : Collections.emptyMap();
    }

    /**
     * Convenience constructor without the {@code streamToolCall} flag (deferred end disabled).
     *
     * @param toolName tool name
     * @param emitConfirmTool whether to emit a deferred confirm_changes tool call
     * @param stateKey the key in the state object to predict from the tool argument
     * @param toolArgument the argument name providing the value (empty = whole args)
     * @param toPayload payload for the PredictState CustomEvent
     */
    public PredictStateMapping(
            String toolName,
            boolean emitConfirmTool,
            String stateKey,
            String toolArgument,
            Map<String, Object> toPayload) {
        this(toolName, emitConfirmTool, false, stateKey, toolArgument, toPayload);
    }

    /**
     * Legacy constructor without argument-derivation fields (kept for the pre-parity API).
     *
     * @param toolName tool name
     * @param emitConfirmTool whether to emit a deferred confirm_changes tool call
     * @param toPayload the payload for the PredictState CustomEvent
     */
    public PredictStateMapping(String toolName, boolean emitConfirmTool, Map<String, Object> toPayload) {
        this(toolName, emitConfirmTool, false, null, null, toPayload);
    }

    /**
     * Converts to the payload shape expected by the UI ({@code state_key}/{@code tool}/
     * {@code tool_argument}), matching the Python {@code to_payload()}.
     *
     * @return UI-expected payload fields
     */
    public Map<String, Object> toPayloadFields() {
        // Python's to_payload returns the raw fields (which may be None for the legacy
        // 3-arg constructor); Map.of rejects null so build via LinkedHashMap.
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("state_key", stateKey);
        payload.put("tool", toolName);
        payload.put("tool_argument", toolArgument);
        return payload;
    }

    /**
     * Normalizes a single mapping into a one-element list.
     *
     * @param single the single mapping (may be null)
     * @return a one-element list, or an empty list when {@code single} is null
     */
    public static List<PredictStateMapping> normalize(PredictStateMapping single) {
        return single == null ? List.of() : List.of(single);
    }

    /**
     * Normalizes an iterable of mappings into a concrete list, mirroring the Python
     * {@code config.normalize_predict_state}: {@code None} -&gt; empty list, a single mapping
     * -&gt; one-element list, an iterable -&gt; its concrete list.
     *
     * @param value the config value: a single mapping or an iterable (may be null)
     * @return the concrete, non-null list of mappings sorted per the source order
     */
    public static List<PredictStateMapping> normalize(Iterable<PredictStateMapping> value) {
        if (value == null) {
            return List.of();
        }
        List<PredictStateMapping> result = new ArrayList<>();
        for (PredictStateMapping m : value) {
            result.add(m);
        }
        return result;
    }
}
