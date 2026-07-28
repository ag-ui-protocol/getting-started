package com.agui.community.server;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * An {@link EventSink} that records the frames written to it. Thread-safe because
 * frames may be delivered from an agent's own publishing thread.
 */
final class RecordingEventSink implements EventSink {

    final List<String> frames = new CopyOnWriteArrayList<>();
    volatile boolean closed;
    private final boolean failWrite;

    RecordingEventSink() {
        this(false);
    }

    RecordingEventSink(boolean failWrite) {
        this.failWrite = failWrite;
    }

    @Override
    public void write(String frame) throws IOException {
        if (failWrite) {
            throw new IOException("client gone");
        }
        frames.add(frame);
    }

    @Override
    public void close() {
        closed = true;
    }
}
