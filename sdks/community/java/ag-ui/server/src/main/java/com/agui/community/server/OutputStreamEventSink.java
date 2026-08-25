package com.agui.community.server;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * An {@link EventSink} that writes UTF-8 encoded frames to a blocking
 * {@link OutputStream}, flushing after each frame so events reach the client as
 * soon as they are produced. Suitable for any blocking-IO transport (such as the
 * JDK HTTP server or a servlet response).
 */
public final class OutputStreamEventSink implements EventSink {

    private final OutputStream out;

    /**
     * Creates a sink over the given output stream.
     *
     * @param out the output stream to write frames to (required)
     */
    public OutputStreamEventSink(OutputStream out) {
        this.out = Objects.requireNonNull(out, "out must not be null");
    }

    @Override
    public void write(String frame) throws IOException {
        out.write(frame.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    @Override
    public void close() throws IOException {
        out.close();
    }
}
