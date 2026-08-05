package com.agui.community.core.event;

import java.util.List;
import java.util.Objects;

/**
 * Carries an incremental update to a structured activity as a sequence of JSON
 * Patch (RFC 6902) operations.
 *
 * @param messageId    the target activity message id (required)
 * @param activityType the activity discriminator (required)
 * @param patch        the JSON Patch operations to apply; never {@code null}
 *                     (required, copied to an unmodifiable list)
 * @param timestamp    the event creation time in epoch milliseconds, or
 *                     {@code null} (optional)
 * @param rawEvent     the original event this was transformed from, or
 *                     {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ActivityDeltaEvent(String messageId, String activityType,
                                 List<JsonPatchOperation> patch, Long timestamp, Object rawEvent)
        implements Event {

    public ActivityDeltaEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
        Objects.requireNonNull(activityType, "activityType must not be null");
        Objects.requireNonNull(patch, "patch must not be null");
        patch = List.copyOf(patch);
    }

    /**
     * Creates an activity-delta event with the required fields.
     *
     * @param messageId    the target activity message id
     * @param activityType the activity discriminator
     * @param patch        the JSON Patch operations to apply
     */
    public ActivityDeltaEvent(String messageId, String activityType, List<JsonPatchOperation> patch) {
        this(messageId, activityType, patch, null, null);
    }

    @Override
    public EventType type() {
        return EventType.ACTIVITY_DELTA;
    }
}
