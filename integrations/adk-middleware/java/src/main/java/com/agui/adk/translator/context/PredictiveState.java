package com.agui.adk.translator.context;

import com.agui.adk.translator.PredictStateMapping;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Holds configuration and state for predictive state features for a single translation run.
 */
public class PredictiveState {
    private final Map<String, List<PredictStateMapping>> mappingsByToolName;
    private final Set<String> emittedForTools;
    private final Set<String> emittedConfirmForTools;

    /**
     * Creates predictive-state bookkeeping from a detached configuration snapshot.
     *
     * @param config predictive-state mappings, or {@code null} for none
     */
    public PredictiveState(List<PredictStateMapping> config) {
        List<PredictStateMapping> mappings = config == null ? List.of() : List.copyOf(config);
        emittedForTools = new HashSet<>();
        emittedConfirmForTools = new HashSet<>();
        mappingsByToolName = mappings.stream().collect(Collectors.collectingAndThen(
                Collectors.groupingBy(PredictStateMapping::toolName),
                grouped -> grouped.entrySet().stream().collect(Collectors.toUnmodifiableMap(
                        Map.Entry::getKey, entry -> List.copyOf(entry.getValue())))));
    }

    /**
     * Returns whether the named tool has predictive-state mappings.
     *
     * @param toolName tool name
     * @return whether mappings are configured
     */
    public boolean hasToolConfig(String toolName) {
        return mappingsByToolName.containsKey(toolName);
    }

    /**
     * Returns whether predictive state was emitted for the named tool.
     *
     * @param toolName tool name
     * @return whether predictive state was emitted
     */
    public boolean hasEmittedForTool(String toolName) {
        return emittedForTools.contains(toolName);
    }

    /**
     * Returns whether confirmation was emitted for the named tool.
     *
     * @param toolName tool name
     * @return whether confirmation was emitted
     */
    public boolean hasEmittedConfirmForTool(String toolName) {
        return emittedConfirmForTools.contains(toolName);
    }

    /**
     * Tests whether any mapping requests a confirmation tool.
     *
     * @param toolName tool name
     * @return whether confirmation should be emitted
     */
    public boolean shouldEmitConfirmForTool(String toolName) {
        return mappingsByToolName.getOrDefault(toolName, List.of())
                     .stream()
                     .anyMatch(PredictStateMapping::emitConfirmTool);
    }

    /**
     * Returns the immutable predictive-state mappings for the named tool.
     *
     * @param toolName tool name
     * @return immutable configured mappings
     */
    public List<PredictStateMapping> getMappingsForTool(String toolName) {
        return mappingsByToolName.getOrDefault(toolName, List.of());
    }

    /**
     * Marks predictive state as emitted for the named tool.
     *
     * @param toolName tool name
     */
    public void markAsEmittedForTool(String toolName) {
        emittedForTools.add(toolName);
    }

    /**
     * Marks confirmation as emitted for the named tool.
     *
     * @param toolName tool name
     */
    public void markAsEmittedConfirmForTool(String toolName) {
        emittedConfirmForTools.add(toolName);
    }

    /**
     * Resets the per-tool emission bookkeeping (Python {@code EventTranslator.reset} predict
     * fields): predictive-state and confirm events are eligible for emission again.
     */
    public void reset() {
        emittedForTools.clear();
        emittedConfirmForTools.clear();
    }
}
