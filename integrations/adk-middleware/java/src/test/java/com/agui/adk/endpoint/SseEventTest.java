package com.agui.adk.endpoint;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class SseEventTest {

    @Test
    void framesBareDataAsDataLineWithTrailingBlankLine() {
        String raw = "{\"type\": \"run_end\"}";
        assertThat(SseEvent.frame(raw, null)).isEqualTo("data: " + raw + "\n\n");
    }

    @Test
    void framesWithEventNameBeforeDataLine() {
        String raw = "{\"error\": \"x\"}";
        assertThat(SseEvent.frame(raw, "error"))
                .isEqualTo("event: error\ndata: " + raw + "\n\n");
    }

    @Test
    void stripsNewlinesFromEventName() {
        assertThat(SseEvent.frame("d", "bad\nname")).isEqualTo("event: badname\ndata: d\n\n");
    }

    @Test
    void splitsMultiLineDataIntoSingleDataLinesPerChunk() {
        // sse_starlette: _LINE_SEP_EXPR.split(data) -> one regexp per line
        assertThat(SseEvent.frame("line1\nline2", null))
                .isEqualTo("data: line1\ndata: line2\n\n");
        assertThat(SseEvent.frame("a\r\nb", null)).isEqualTo("data: a\ndata: b\n\n");
        assertThat(SseEvent.frame("a\rb", null)).isEqualTo("data: a\ndata: b\n\n");
    }

    @Test
    void splitsMultiLineDataWithEventNameToo() {
        assertThat(SseEvent.frame("line1\nline2", "evt"))
                .isEqualTo("event: evt\ndata: line1\ndata: line2\n\n");
    }

    @Test
    void errorFrameUsesEventError() {
        assertThat(SseEvent.errorFrame(SseEvent.ENCODING_ERROR_DATA))
                .isEqualTo("event: error\ndata: " + SseEvent.ENCODING_ERROR_DATA + "\n\n");
    }

    @Test
    void fallbackPayloadStringsMatchPythonLiterals() {
        assertThat(SseEvent.ENCODING_ERROR_DATA)
                .isEqualTo("{\"error\": \"Event encoding failed\"}");
        assertThat(SseEvent.AGENT_ERROR_DATA)
                .isEqualTo("{\"error\": \"Agent execution failed\"}");
        assertThat(SseEvent.LEGACY_ENCODING_ERROR)
                .isEqualTo("data: {\"error\": \"Event encoding failed\"}\n\n");
        assertThat(SseEvent.LEGACY_AGENT_ERROR)
                .isEqualTo("data: {\"error\": \"Agent execution failed\"}\n\n");
    }
}
