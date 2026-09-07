package com.agui.adk.encoding;

import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.server.SseEventEncoder;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.adk.serialization.JacksonAgUiSerializer;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Exact-wire tests for retained frontend-call JSON. */
class PreEncodedSseEventEncoderTest {
    private final SseEventEncoder official = new SseEventEncoder(
            new JacksonAgUiSerializer(new ObjectMapper()));
    private final PreEncodedSseEventEncoder encoder = new PreEncodedSseEventEncoder(official);

    @Test
    void preservesExactPreEncodedJsonAndOfficialMultilineFraming() {
        String exact = "{  \"type\" : \"TOOL_CALL_CHUNK\",\n"
                + " \"toolCallId\":\"c\", \"toolCallName\":\"tool\", \"delta\":\"{}\" }";
        ToolCallChunkEvent delegate = new ToolCallChunkEvent("c", "tool", "{}");
        ToolCallChunkEvent event = new ToolCallChunkEvent("c", "tool", null, "{}", null,
                new PreEncodedEvent(delegate, exact));

        assertThat(encoder.encode(event)).isEqualTo("data: {  \"type\" : \"TOOL_CALL_CHUNK\",\n"
                + "data:  \"toolCallId\":\"c\", \"toolCallName\":\"tool\", \"delta\":\"{}\" }\n\n");
    }

    @Test
    void delegatesOrdinaryEventsToTheOfficialEncoder() {
        RunErrorEvent event = new RunErrorEvent("failed", "CODE", null, null);
        assertThat(encoder.encode(event)).isEqualTo(official.encode(event));
    }

    @Test
    void rejectsInvalidPreEncodedJsonBeforeStreaming() {
        ToolCallChunkEvent delegate = new ToolCallChunkEvent("call", "tool", "{}");

        assertThatThrownBy(() -> new PreEncodedEvent(delegate, "not-json"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("valid");
        assertThatThrownBy(() -> new PreEncodedEvent(delegate, "[]"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("object");
        assertThatThrownBy(() -> new PreEncodedEvent(delegate, "{} {}"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("valid");
    }

    @Test
    void rejectsAWrapperWhoseDelegateDoesNotMatchTheVisibleEvent() {
        ToolCallChunkEvent event = new ToolCallChunkEvent("visible", "tool", null, "{}", null,
                new PreEncodedEvent(new ToolCallChunkEvent("stored", "tool", "{}"), "{}"));

        assertThatThrownBy(() -> encoder.encode(event))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not match");
    }
}
