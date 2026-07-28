package com.agui.community.core.event;

import java.util.Objects;

/**
 * Carries a complete snapshot of the agent state.
 *
 * @param snapshot  the complete state representation (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record StateSnapshotEvent(Object snapshot, Long timestamp, Object rawEvent)
        implements Event {

    public StateSnapshotEvent {
        Objects.requireNonNull(snapshot, "snapshot must not be null");
    }

    /**
     * Creates a state-snapshot event from a state representation.
     *
     * @param snapshot the complete state representation
     */
    public StateSnapshotEvent(Object snapshot) {
        this(snapshot, null, null);
    }

    @Override
    public EventType type() {
        return EventType.STATE_SNAPSHOT;
    }
}
