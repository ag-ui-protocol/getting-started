package com.agui.community.server;

import com.agui.community.core.event.Event;

/**
 * Encodes an AG-UI {@link Event} into a wire frame for a particular transport
 * protocol. This is the single point of variation between protocols: Server-Sent
 * Events wraps each event in {@code data:} lines (see {@link SseEventEncoder}),
 * whereas a WebSocket transport would emit the bare serialized payload as one
 * message.
 *
 * <p>The rest of the server machinery — {@link AgentRunHandler}, the
 * {@code EventRelaySubscriber}, and the {@link EventSink} — stays protocol-neutral
 * and delegates framing to an implementation of this interface.
 */
public interface EventEncoder {

    /**
     * Encodes the given event as a complete wire frame for this protocol.
     *
     * @param event the event to encode (required)
     * @return the encoded frame
     */
    String encode(Event event);
}
