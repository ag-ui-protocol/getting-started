package com.agui.adk.translator.context;


import java.util.*;

/**
 * Holds all state related to tool calls for a single translation run.
 */
public class ToolState {
    private final Map<String, String> activeToolCalls = new HashMap<>();
    private final Set<String> longRunningToolIds = new HashSet<>(); // Changed to Set and initialized
    private final Set<String> predictiveStateToolCallIds = new HashSet<>();
    private final List<com.agui.community.core.event.Event> deferredConfirmEvents = new ArrayList<>();
    private final Map<String, List<String>> lroEmittedIdsByName = new LinkedHashMap<>();

    // --- Query Methods ---
    public boolean isLongRunningTool(String toolCallId) {
        return longRunningToolIds.contains(toolCallId);
    }

    /**
     * Whether any long-running tool ids have been registered for the current event.
     *
     * @return true when at least one long-running id is populated
     */
    public boolean longRunningToolIdsPresent() {
        return !longRunningToolIds.isEmpty();
    }

    public boolean isPredictiveStateTool(String toolCallId) {
        return predictiveStateToolCallIds.contains(toolCallId);
    }

    public boolean isActive(String toolCallId) {
        return activeToolCalls.containsKey(toolCallId);
    }

    /**
     * Returns and clears deferred confirmation events.
     *
     * @return deferred events
     */
    public List<com.agui.community.core.event.Event> getAndClearDeferredEvents() {
        if (deferredConfirmEvents.isEmpty()) {
            return List.of();
        }
        List<com.agui.community.core.event.Event> events = new ArrayList<>(this.deferredConfirmEvents);
        this.deferredConfirmEvents.clear();
        return events;
    }

    // --- State Mutation Methods ---
    public void populateLongRunningToolIds(Set<String> ids) {
        this.longRunningToolIds.clear();
        this.longRunningToolIds.addAll(ids);
    }

    public void startTrackingToolCall(String toolCallId) {
        this.activeToolCalls.put(toolCallId, toolCallId);
    }

    public void endTrackingToolCall(String toolCallId) {
        this.activeToolCalls.remove(toolCallId);
    }

    public void addPredictiveStateToolCallId(String toolCallId) {
        this.predictiveStateToolCallIds.add(toolCallId);
    }

    public void addDeferredConfirmEvents(List<com.agui.community.core.event.Event> events) {
        this.deferredConfirmEvents.addAll(events);
    }

    /**
     * Whether any deferred confirm events are waiting (Python {@code has_deferred_confirm_events}).
     *
     * @return true when deferred confirm events exist
     */
    public boolean hasDeferredConfirmEvents() {
        return !deferredConfirmEvents.isEmpty();
    }

    /**
     * Whether the position-th same-name long-running call in one event is a replay that was
     * already emitted under a different ID in this run (Python positional high-water-mark dedup,
     * GitHub #1168). Genuinely parallel same-name calls in one event exceed the mark and emit.
     *
     * @param name tool call name
     * @param position 1-based position of this same-name call within the event
     * @return true when this positional call is a replay to suppress
     */
    public boolean isLongRunningCallReplay(String name, int position) {
        return position <= lroEmittedIdsByName.getOrDefault(name, List.of()).size();
    }

    /**
     * Records an emitted long-running call id under its tool name (the positional high-water mark).
     *
     * @param name tool call name
     * @param id emitted tool call id
     */
    public void recordLongRunningEmitted(String name, String id) {
        lroEmittedIdsByName.computeIfAbsent(name, k -> new ArrayList<>()).add(id);
    }

    /**
     * Resets all tool-call translation state (Python {@code EventTranslator.reset} tool fields):
     * active calls, long-running ids, predictive-state ids, deferred confirms and the
     * long-running high-water marks.
     */
    public void reset() {
        activeToolCalls.clear();
        longRunningToolIds.clear();
        predictiveStateToolCallIds.clear();
        deferredConfirmEvents.clear();
        lroEmittedIdsByName.clear();
    }
}
