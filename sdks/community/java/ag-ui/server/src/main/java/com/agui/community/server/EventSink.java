package com.agui.community.server;

import java.io.IOException;

/**
 * A transport-neutral destination for already-encoded event frames. A concrete
 * adapter (for example over a {@code java.io.OutputStream}, a servlet response,
 * or a WebSocket session) implements this interface so that the rest of the
 * server machinery stays free of any particular HTTP framework or wire protocol.
 *
 * <p>The frames written here are produced by an {@link EventEncoder}, so this
 * sink is unconcerned with how an event is framed — it only delivers the bytes.
 *
 * <p>A sink is written from a single thread (the one delivering the agent's
 * events) and is closed exactly once when the run terminates.
 */
public interface EventSink {

    /**
     * Writes a single, already-encoded frame and flushes it to the client.
     *
     * @param frame the frame to write (for example {@code "data: {...}\n\n"} for
     *              SSE)
     * @throws IOException if the frame cannot be written (for example because the
     *                     client has disconnected)
     */
    void write(String frame) throws IOException;

    /**
     * Signals that no further frames will be written and releases any underlying
     * resources.
     *
     * @throws IOException if closing the underlying resource fails
     */
    void close() throws IOException;
}
