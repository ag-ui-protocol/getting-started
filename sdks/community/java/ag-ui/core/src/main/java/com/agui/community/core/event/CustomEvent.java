package com.agui.community.core.event;

import java.util.Objects;

/**
 * An application-defined custom event.
 *
 * @param name      the custom event type name (required)
 * @param value     the associated event data (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record CustomEvent(String name, Object value, Long timestamp, Object rawEvent)
        implements Event {

    public CustomEvent {
        Objects.requireNonNull(name, "name must not be null");
        Objects.requireNonNull(value, "value must not be null");
    }

    /**
     * Creates a custom event with a name and value.
     *
     * @param name  the custom event type name
     * @param value the associated event data
     */
    public CustomEvent(String name, Object value) {
        this(name, value, null, null);
    }

    @Override
    public EventType type() {
        return EventType.CUSTOM;
    }
}
