package com.agui.community.core.event;

import java.util.List;
import java.util.Objects;

/**
 * Carries an incremental update to the agent state as a sequence of JSON Patch
 * (RFC 6902) operations.
 *
 * @param delta     the JSON Patch operations to apply; never {@code null}
 *                  (required, copied to an unmodifiable list)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record StateDeltaEvent(List<JsonPatchOperation> delta, Long timestamp, Object rawEvent)
        implements Event {

    public StateDeltaEvent {
        Objects.requireNonNull(delta, "delta must not be null");
        delta = List.copyOf(delta);
    }

    /**
     * Creates a state-delta event from a list of patch operations.
     *
     * @param delta the JSON Patch operations to apply
     */
    public StateDeltaEvent(List<JsonPatchOperation> delta) {
        this(delta, null, null);
    }

    @Override
    public EventType type() {
        return EventType.STATE_DELTA;
    }
}
