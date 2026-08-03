package com.agui.community.core.event;

import java.util.Objects;

/**
 * Carries a complete snapshot of a structured activity (such as a plan or a
 * search) attached to a message.
 *
 * @param messageId    the activity message identifier (required)
 * @param activityType the activity discriminator, e.g. {@code "PLAN"} or
 *                     {@code "SEARCH"} (required)
 * @param content      the structured JSON activity state (required)
 * @param replace      whether to replace the existing activity, or {@code null}
 *                     to default to {@code true} (optional)
 * @param timestamp    the event creation time in epoch milliseconds, or
 *                     {@code null} (optional)
 * @param rawEvent     the original event this was transformed from, or
 *                     {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ActivitySnapshotEvent(String messageId, String activityType, Object content,
                                    Boolean replace, Long timestamp, Object rawEvent)
        implements Event {

    public ActivitySnapshotEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
        Objects.requireNonNull(activityType, "activityType must not be null");
        Objects.requireNonNull(content, "content must not be null");
    }

    /**
     * Creates an activity-snapshot event with the required fields.
     *
     * @param messageId    the activity message identifier
     * @param activityType the activity discriminator
     * @param content      the structured JSON activity state
     */
    public ActivitySnapshotEvent(String messageId, String activityType, Object content) {
        this(messageId, activityType, content, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.ACTIVITY_SNAPSHOT;
    }
}
