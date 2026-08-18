package com.agui.community.core.event;

import com.agui.community.core.interrupt.RunOutcome;
import java.util.Objects;

/**
 * Signals that an agent run has finished.
 *
 * @param threadId  the conversation thread id (required)
 * @param runId     the agent run id (required)
 * @param outcome   the run outcome ({@code success} or {@code interrupt}), or
 *                  {@code null} for a normal completion (optional)
 * @param result    a free-form completion payload, or {@code null} (optional)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public record RunFinishedEvent(String threadId, String runId, RunOutcome outcome, Object result,
                               Long timestamp, Object rawEvent) implements Event {

    public RunFinishedEvent {
        Objects.requireNonNull(threadId, "threadId must not be null");
        Objects.requireNonNull(runId, "runId must not be null");
    }

    /**
     * Creates a run-finished event with only the required fields.
     *
     * @param threadId the conversation thread id
     * @param runId    the agent run id
     */
    public RunFinishedEvent(String threadId, String runId) {
        this(threadId, runId, null, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.RUN_FINISHED;
    }
}
