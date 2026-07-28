package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals that an agent run has started.
 *
 * @param threadId    the conversation thread id (required)
 * @param runId       the agent run id (required)
 * @param parentRunId the prior run id for branching/time travel, or
 *                    {@code null} (optional)
 * @param input       the agent input payload for this run, or {@code null}
 *                    (optional)
 * @param timestamp   the event creation time in epoch milliseconds, or
 *                    {@code null} (optional)
 * @param rawEvent    the original event this was transformed from, or
 *                    {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record RunStartedEvent(String threadId, String runId, String parentRunId, Object input,
                              Long timestamp, Object rawEvent) implements Event {

    public RunStartedEvent {
        Objects.requireNonNull(threadId, "threadId must not be null");
        Objects.requireNonNull(runId, "runId must not be null");
    }

    /**
     * Creates a run-started event with only the required fields.
     *
     * @param threadId the conversation thread id
     * @param runId    the agent run id
     */
    public RunStartedEvent(String threadId, String runId) {
        this(threadId, runId, null, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.RUN_STARTED;
    }
}
