package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals that an agent run has errored.
 *
 * @param message   the error message (required)
 * @param code      the error code, or {@code null} (optional)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record RunErrorEvent(String message, String code, Long timestamp, Object rawEvent)
        implements Event {

    public RunErrorEvent {
        Objects.requireNonNull(message, "message must not be null");
    }

    /**
     * Creates a run-error event with only an error message.
     *
     * @param message the error message
     */
    public RunErrorEvent(String message) {
        this(message, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.RUN_ERROR;
    }
}
