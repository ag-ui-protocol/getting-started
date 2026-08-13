package com.agui.adk.encoding;

import com.agui.community.core.event.Event;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.server.EventEncoder;
import com.agui.community.server.SseEventEncoder;

import java.util.Objects;

/** SSE encoder that preserves validated frontend-call JSON without re-encoding it. */
public final class PreEncodedSseEventEncoder implements EventEncoder {
    private final SseEventEncoder delegate;

    /**
     * Creates an encoder backed by the official SSE encoder for ordinary events.
     *
     * @param delegate official SSE encoder
     */
    public PreEncodedSseEventEncoder(SseEventEncoder delegate) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
    }

    @Override
    public String encode(Event event) {
        Objects.requireNonNull(event, "event");
        if (event.rawEvent() instanceof PreEncodedEvent encoded) {
            if (!(event instanceof ToolCallChunkEvent chunk) || !sameChunk(chunk, encoded.delegate())) {
                throw new IllegalArgumentException("PreEncodedEvent delegate does not match its enclosing event");
            }
            return frame(encoded.json());
        }
        return delegate.encode(event);
    }

    /**
     * @param left visible event
     * @param right retained delegate
     * @return whether all wire fields match
     */
    private static boolean sameChunk(ToolCallChunkEvent left, ToolCallChunkEvent right) {
        return Objects.equals(left.toolCallId(), right.toolCallId())
                && Objects.equals(left.toolCallName(), right.toolCallName())
                && Objects.equals(left.parentMessageId(), right.parentMessageId())
                && Objects.equals(left.delta(), right.delta())
                && Objects.equals(left.timestamp(), right.timestamp());
    }

    /**
     * @param json exact retained JSON
     * @return official SSE framing of that JSON
     */
    private static String frame(String json) {
        StringBuilder frame = new StringBuilder();
        for (String line : json.split("\n", -1)) {
            frame.append("data: ").append(line).append('\n');
        }
        return frame.append('\n').toString();
    }
}
