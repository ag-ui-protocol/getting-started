package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals that a named step within a run has started.
 *
 * @param stepName  the name of the step (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record StepStartedEvent(String stepName, Long timestamp, Object rawEvent) implements Event {

    public StepStartedEvent {
        Objects.requireNonNull(stepName, "stepName must not be null");
    }

    /**
     * Creates a step-started event from a step name.
     *
     * @param stepName the name of the step
     */
    public StepStartedEvent(String stepName) {
        this(stepName, null, null);
    }

    @Override
    public EventType type() {
        return EventType.STEP_STARTED;
    }
}
