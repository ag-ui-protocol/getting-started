package com.agui.adk.execution;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Tracks the state of one background AG-UI execution, mirroring Python
 * {@code ExecutionState}: completion status, HITL pending tool calls, and the
 * opaque status string surfaced to the hosting application.
 */
public final class ExecutionState {
    private final String threadId;
    private final long startTimeNanos;
    private boolean complete;
    private boolean taskDone;
    private final Set<String> pendingToolCalls = new LinkedHashSet<>();

    /**
     * Creates an execution state for the given thread.
     *
     * @param threadId AG-UI thread identifier
     */
    public ExecutionState(String threadId) {
        this.threadId = threadId;
        this.startTimeNanos = System.nanoTime();
    }

    /**
     * Returns the owning thread identifier.
     *
     * @return thread identifier
     */
    public String getThreadId() {
        return threadId;
    }

    /**
     * Marks this execution complete.
     */
    public void markComplete() {
        this.complete = true;
    }

    /**
     * Marks the underlying execution task as finished, before completion is recorded. Mirrors the
     * Python {@code asyncio.Task.done()} state that {@code get_status} reports as {@code task_done}.
     */
    public void markTaskDone() {
        this.taskDone = true;
    }

    /**
     * Tracks an outstanding HITL tool call.
     *
     * @param toolCallId tool call identifier
     */
    public void addPendingToolCall(String toolCallId) {
        pendingToolCalls.add(toolCallId);
    }

    /**
     * Removes a resolved HITL tool call.
     *
     * @param toolCallId tool call identifier
     */
    public void removePendingToolCall(String toolCallId) {
        pendingToolCalls.remove(toolCallId);
    }

    /**
     * Whether any HITL tool calls remain outstanding.
     *
     * @return true when pending tool calls exist
     */
    public boolean hasPendingToolCalls() {
        return !pendingToolCalls.isEmpty();
    }

    /**
     * Whether this execution has exceeded the given timeout.
     *
     * @param timeoutSeconds timeout in seconds
     * @return true when the execution has been running longer than the timeout
     */
    public boolean isStale(int timeoutSeconds) {
        return (System.nanoTime() - startTimeNanos) / 1_000_000_000L > timeoutSeconds;
    }

    /**
     * Returns the total execution time in seconds since this state was created (Python
     * {@code ExecutionState.get_execution_time}).
     *
     * @return elapsed time in seconds
     */
    public double getExecutionTime() {
        return (System.nanoTime() - startTimeNanos) / 1_000_000_000.0;
    }

    /**
     * Returns the opaque status string, identical to Python {@code ExecutionState.get_status()}.
     *
     * @return one of {@code running}/{@code complete_awaiting_tools}/{@code complete}
     */
    public String getStatus() {
        if (complete) {
            return hasPendingToolCalls() ? "complete_awaiting_tools" : "complete";
        }
        if (taskDone) {
            return "task_done";
        }
        return "running";
    }
}
