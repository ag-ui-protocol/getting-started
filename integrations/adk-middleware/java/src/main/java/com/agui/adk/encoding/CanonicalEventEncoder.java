package com.agui.adk.encoding;

import com.agui.community.core.event.ToolCallChunkEvent;

/** Encodes one official frontend-call event before it can become client-visible. */
@FunctionalInterface
public interface CanonicalEventEncoder {
    EncodedEvent encode(ToolCallChunkEvent event);
}
