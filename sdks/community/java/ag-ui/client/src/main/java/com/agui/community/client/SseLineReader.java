package com.agui.community.client;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Reads bounded UTF-8 lines without materializing an unbounded HTTP body line. */
final class SseLineReader {

    private final InputStream input;
    private final int maxLineBytes;
    private boolean skipLf;

    SseLineReader(InputStream input, int maxLineBytes) {
        this.input = new BufferedInputStream(input);
        this.maxLineBytes = maxLineBytes;
    }

    /** Accepts LF, CRLF and CR; returns a final unterminated line, then null at EOF. */
    String readLine() throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(Math.min(1024, maxLineBytes));
        while (true) {
            int next = input.read();
            if (skipLf) {
                skipLf = false;
                if (next == '\n') {
                    continue;
                }
            }
            if (next == -1) {
                return line.size() == 0 ? null : line.toString(StandardCharsets.UTF_8);
            }
            if (next == '\n' || next == '\r') {
                skipLf = next == '\r';
                return line.toString(StandardCharsets.UTF_8);
            }
            if (line.size() == maxLineBytes) {
                throw new HttpAgentException("SSE line exceeds maximum size of " + maxLineBytes + " bytes");
            }
            line.write(next);
        }
    }
}
