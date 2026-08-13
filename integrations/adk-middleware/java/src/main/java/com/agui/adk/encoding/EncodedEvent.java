package com.agui.adk.encoding;

import com.agui.community.core.event.ToolCallChunkEvent;

import java.util.Objects;

/** A prevalidated official event together with its exact wire JSON. */
public record EncodedEvent(ToolCallChunkEvent event, String json) {
    public EncodedEvent {
        event = Objects.requireNonNull(event, "event");
        json = Objects.requireNonNull(json, "json");
    }
}
