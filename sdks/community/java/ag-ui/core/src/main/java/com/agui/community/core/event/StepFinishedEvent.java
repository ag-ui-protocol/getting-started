package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals that a named step within a run has finished. The {@link #stepName()}
 * must match the corresponding {@link StepStartedEvent}.
 *
 * @param stepName  the name of the step (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record StepFinishedEvent(String stepName, Long timestamp, Object rawEvent) implements Event {

    public StepFinishedEvent {
        Objects.requireNonNull(stepName, "stepName must not be null");
    }

    /**
     * Creates a step-finished event from a step name.
     *
     * @param stepName the name of the step
     */
    public StepFinishedEvent(String stepName) {
        this(stepName, null, null);
    }

    @Override
    public EventType type() {
        return EventType.STEP_FINISHED;
    }
}
