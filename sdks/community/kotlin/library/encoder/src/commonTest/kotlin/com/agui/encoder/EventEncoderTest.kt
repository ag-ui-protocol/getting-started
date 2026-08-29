package com.agui.encoder

import com.agui.core.types.RunStartedEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EventEncoderTest {

    private val event = RunStartedEvent(threadId = "t1", runId = "r1")
    // Compact JSON with the "type" discriminator first, then declaration order;
    // null timestamp/rawEvent omitted (AgUiJson has explicitNulls = false).
    private val expectedJson = """{"type":"RUN_STARTED","threadId":"t1","runId":"r1"}"""

    @Test
    fun getContentTypeIsEventStreamByDefault() {
        assertEquals("text/event-stream", EventEncoder().getContentType())
        assertEquals("text/event-stream", EventEncoder.SSE_CONTENT_TYPE)
    }

    @Test
    fun getContentTypeStaysSseEvenWhenProtobufRequested() {
        // No Kotlin proto codec yet — proto Accept still yields SSE (matches Python).
        val encoder = EventEncoder(accept = EventEncoder.AGUI_MEDIA_TYPE)
        assertEquals("text/event-stream", encoder.getContentType())
    }

    @Test
    fun encodeProducesCanonicalSseFraming() {
        // Exact bytes: "data: " prefix (one space), compact JSON, trailing blank line.
        assertEquals("data: $expectedJson\n\n", EventEncoder().encode(event))
    }

    @Test
    fun encodeSseMatchesEncode() {
        val encoder = EventEncoder()
        assertEquals(encoder.encode(event), encoder.encodeSSE(event))
    }

    @Test
    fun encodeStartsWithDataPrefixAndEndsWithBlankLine() {
        val encoded = EventEncoder().encode(event)
        assertTrue(encoded.startsWith("data: "), "must start with 'data: '")
        assertTrue(encoded.endsWith("\n\n"), "must end with a blank line")
    }

    @Test
    fun encodeToJsonProducesUnframedBody() {
        // No "data: " prefix and no trailing blank line — just the compact JSON body.
        assertEquals(expectedJson, EventEncoder().encodeToJson(event))
    }

    @Test
    fun encodeSseWrapsEncodeToJson() {
        // encodeSSE is exactly the framed form of encodeToJson (for self-framing transports the
        // body-only path must yield the same JSON the SSE path carries).
        val encoder = EventEncoder()
        assertEquals("data: ${encoder.encodeToJson(event)}\n\n", encoder.encodeSSE(event))
    }
}
