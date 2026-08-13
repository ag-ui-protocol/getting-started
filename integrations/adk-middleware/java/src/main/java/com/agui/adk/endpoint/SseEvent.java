package com.agui.adk.endpoint;

/**
 * Pure port of the Python {@code endpoint.py _sse_event} SSE wire framing (byte-exact with
 * {@code sse_starlette.ServerSentEvent(data=..., sep="\n")}).
 *
 * <p>A single-line {@code data} value frames as {@code data: {raw}\n\n}; with an explicit
 * {@code event} name it frames as {@code event: {name}\ndata: {raw}\n\n}, with newlines
 * stripped from the event name (matching {@code _LINE_SEP_EXPR.sub("", event)}).
 *
 * <p>The broader HTTP hosting wire-up (FastAPI/StreamingResponse negotiation) is hosting-app
 * territory; this framing is the pure, offline-testable core.
 */
public final class SseEvent {

    private SseEvent() {
    }

    /** The encoded ErrorEvent payload used at the end of an SSE stream (Python literal). */
    public static final String ENCODING_ERROR_DATA = "{\"error\": \"Event encoding failed\"}";

    /** The encoded ErrorEvent payload used at the end of an SSE stream (Python literal). */
    public static final String AGENT_ERROR_DATA = "{\"error\": \"Agent execution failed\"}";

    /** Legacy non-SSE fallback frame for an encoding error (Python literal). */
    public static final String LEGACY_ENCODING_ERROR = "data: {\"error\": \"Event encoding failed\"}\n\n";

    /** Legacy non-SSE fallback frame for an agent error (Python literal). */
    public static final String LEGACY_AGENT_ERROR = "data: {\"error\": \"Agent execution failed\"}\n\n";

    /**
     * Frames a raw data string as a Server-Sent Event (Python {@code _sse_event}).
     *
     * @param rawData the already-serialized payload (single line, JSON)
     * @param event   the optional SSE event name, or null for a bare {@code data:} frame
     * @return the byte-exact SSE frame (with {@code \n} line endings)
     */
    public static String frame(String rawData, String event) {
        StringBuilder sb = new StringBuilder();
        if (event != null) {
            // sse_starlette strips newlines from the event name (_LINE_SEP_EXPR.sub("", event)).
            sb.append("event: ").append(event.replaceAll("\r\n|\r|\n", "")).append('\n');
        }
        if (rawData != null) {
            // sse_starlette splits multi-line data into one `data:` line per chunk.
            String[] chunks = rawData.split("\r\n|\r|\n", -1);
            for (String chunk : chunks) {
                sb.append("data: ").append(chunk).append('\n');
            }
        }
        sb.append('\n');
        return sb.toString();
    }

    /**
     * Frames a JSON error payload as an {@code event: error} SSE frame (the final structured
     * fallback in {@code _sse_stream}).
     *
     * @param errorJson the JSON error payload
     * @return the {@code event: error} SSE frame
     */
    public static String errorFrame(String errorJson) {
        return frame(errorJson, "error");
    }
}
