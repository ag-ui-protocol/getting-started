package com.agui.community.server;

import com.agui.community.core.event.Event;
import com.agui.community.core.serialization.Serializer;
import java.util.Objects;

/**
 * An {@link EventEncoder} that encodes an AG-UI {@link Event} as a Server-Sent
 * Events frame. This is the server-side counterpart to the client's SSE parser:
 * each event is serialized to JSON via the injected {@link Serializer} and
 * wrapped in one or more {@code data:} lines terminated by a blank line.
 *
 * <p>If the serialized JSON spans multiple lines, each line is emitted as its
 * own {@code data:} field; a compliant SSE consumer rejoins them with
 * {@code '\n'}, reconstructing the original payload.
 */
public final class SseEventEncoder implements EventEncoder {

    private final Serializer serializer;

    /**
     * Creates an encoder backed by the given serializer.
     *
     * @param serializer the serializer used to encode events to JSON (required)
     */
    public SseEventEncoder(Serializer serializer) {
        this.serializer = Objects.requireNonNull(serializer, "serializer must not be null");
    }

    /**
     * Encodes the given event as a complete SSE frame.
     *
     * @param event the event to encode (required)
     * @return the SSE frame, ending with a blank line
     */
    @Override
    public String encode(Event event) {
        Objects.requireNonNull(event, "event must not be null");
        String json = serializer.serialize(event);
        StringBuilder frame = new StringBuilder();
        for (String line : json.split("\n", -1)) {
            frame.append("data: ").append(line).append('\n');
        }
        frame.append('\n');
        return frame.toString();
    }
}
