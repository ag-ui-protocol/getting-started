package com.agui.community.core.event;

import java.util.Objects;

/**
 * An application-defined meta event carrying out-of-band signals such as
 * feedback (e.g. {@code "thumbs_up"}).
 *
 * <p>Note: this event type is a DRAFT in the AG-UI specification and may change.
 *
 * @param metaType  the application-defined meta type (required)
 * @param payload   the application-defined payload (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record MetaEvent(String metaType, Object payload, Long timestamp, Object rawEvent)
        implements Event {

    public MetaEvent {
        Objects.requireNonNull(metaType, "metaType must not be null");
        Objects.requireNonNull(payload, "payload must not be null");
    }

    /**
     * Creates a meta event with a type and payload.
     *
     * @param metaType the application-defined meta type
     * @param payload  the application-defined payload
     */
    public MetaEvent(String metaType, Object payload) {
        this(metaType, payload, null, null);
    }

    @Override
    public EventType type() {
        return EventType.META_EVENT;
    }
}
