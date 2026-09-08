package com.agui.community.client;

import java.nio.charset.StandardCharsets;
import java.util.Optional;

/**
 * A minimal parser for the Server-Sent Events (SSE) wire format, fed one line
 * at a time. It accumulates the {@code data} field(s) of an event and emits the
 * combined payload when the event is dispatched (on a blank line).
 *
 * <p>Only the {@code data} field is surfaced; other fields ({@code event},
 * {@code id}, {@code retry}) and comment lines (starting with {@code ':'}) are
 * ignored, which is sufficient for the AG-UI event stream where each event is a
 * single JSON {@code data} payload.
 *
 * <p>This class is not thread-safe; feed lines from a single thread.
 */
final class SseEventParser {

    private final int maxEventBytes;
    private StringBuilder data = new StringBuilder();
    private int dataBytes;
    private boolean hasData;

    SseEventParser() {
        this(SseLimits.DEFAULT.maxEventBytes());
    }

    SseEventParser(int maxEventBytes) {
        this.maxEventBytes = maxEventBytes;
    }

    /**
     * Feeds a single line (without its terminator) into the parser.
     *
     * @param line the line to process
     * @return the combined {@code data} payload if this line dispatched a
     *         complete event (a blank line), otherwise empty
     */
    Optional<String> feed(String line) {
        if (line.isEmpty()) {
            return dispatch();
        }
        if (line.charAt(0) == ':') {
            // Comment line.
            return Optional.empty();
        }
        int colon = line.indexOf(':');
        String field;
        String value;
        if (colon < 0) {
            field = line;
            value = "";
        } else {
            field = line.substring(0, colon);
            value = line.substring(colon + 1);
            if (!value.isEmpty() && value.charAt(0) == ' ') {
                value = value.substring(1);
            }
        }
        if (field.equals("data")) {
            int valueBytes = value.getBytes(StandardCharsets.UTF_8).length;
            long combinedBytes = (long) dataBytes + valueBytes + (hasData ? 1 : 0);
            if (combinedBytes > maxEventBytes) {
                throw new HttpAgentException(
                        "SSE event data exceeds maximum size of " + maxEventBytes + " bytes");
            }
            if (hasData) {
                data.append('\n');
            }
            data.append(value);
            dataBytes = (int) combinedBytes;
            hasData = true;
        }
        return Optional.empty();
    }

    /**
     * Flushes any pending event that was not terminated by a trailing blank
     * line, for use when the underlying stream ends.
     *
     * @return the combined {@code data} payload if one was pending, otherwise
     *         empty
     */
    Optional<String> flush() {
        return dispatch();
    }

    private Optional<String> dispatch() {
        if (!hasData) {
            return Optional.empty();
        }
        String payload = data.toString();
        // Release the backing capacity so a large event is not retained for the
        // rest of a long-lived stream.
        data = new StringBuilder();
        dataBytes = 0;
        hasData = false;
        return Optional.of(payload);
    }
}
