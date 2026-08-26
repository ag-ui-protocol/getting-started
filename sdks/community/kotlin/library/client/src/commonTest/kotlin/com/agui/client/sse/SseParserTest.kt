package com.agui.client.sse

import com.agui.core.types.BaseEvent
import com.agui.core.types.Role
import com.agui.core.types.TextMessageStartEvent
import com.agui.core.types.AgUiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest

class SseParserTest {

    @Test
    fun parseFlow_filtersMalformedEvents() = runTest {
        val parser = SseParser()
        val validEvent = TextMessageStartEvent(messageId = "stream-1", role = Role.ASSISTANT)
        val serialized = AgUiJson.encodeToString(BaseEvent.serializer(), validEvent)
        val payloads = flowOf(
            "not-json",
            serialized,
            "{ \"event\": \"missing \"",
            "  $serialized   "
        )

        val parsed = parser.parseFlow(payloads).toList()

        assertEquals(2, parsed.size)
        parsed.forEach { event ->
            val start = assertIs<TextMessageStartEvent>(event)
            assertEquals("stream-1", start.messageId)
        }
    }

    @Test
    fun parseFlow_dropsPayloadNestedTooDeeplyAndKeepsStreaming() = runTest {
        val parser = SseParser()
        // Far past the limit, and past what any target's stack survives being asked to descend.
        val depth = 100_000
        val deeplyNested = "[".repeat(depth) + "]".repeat(depth)
        val validEvent = TextMessageStartEvent(messageId = "stream-2", role = Role.ASSISTANT)
        val serialized = AgUiJson.encodeToString(BaseEvent.serializer(), validEvent)

        // The nesting is counted before the deserializer is handed the payload, so this test says
        // the same thing on every target rather than relying on a JVM StackOverflowError being
        // thrown and catchable.
        val events = parser.parseFlow(flowOf(deeplyNested, serialized)).toList()

        assertEquals(1, events.size)
        assertIs<TextMessageStartEvent>(events.first())
    }

    @Test
    fun parseFlow_acceptsLegitimatelyDeepPayloads() = runTest {
        val parser = SseParser()
        /*
         * An absolute depth, deliberately not derived from MAX_JSON_DEPTH.
         *
         * Written as `MAX_JSON_DEPTH - 1` this test scales with the constant and passes for any
         * value of it, including one far too low to carry real payloads. 64 levels is well beyond
         * anything the protocol itself emits and is the kind of depth arbitrary customer JSON in a
         * state snapshot reaches, so the limit has to stay above it.
         */
        val depth = 64
        val nested = "[".repeat(depth) + "]".repeat(depth)
        val payload = """{"type":"CUSTOM","name":"deep","value":$nested}"""

        val events = parser.parseFlow(flowOf(payload)).toList()

        assertEquals(1, events.size)
    }

    @Test
    fun parseFlow_doesNotCountBracketsInsideStrings() = runTest {
        val parser = SseParser()
        // Brackets in a string are data, not structure. Counted as nesting, a message whose text
        // happens to contain many of them would be dropped as if it were an attack.
        val brackets = "[".repeat(SseParser.MAX_JSON_DEPTH * 2)
        val event = TextMessageStartEvent(messageId = brackets, role = Role.ASSISTANT)
        val serialized = AgUiJson.encodeToString(BaseEvent.serializer(), event)

        val events = parser.parseFlow(flowOf(serialized)).toList()

        assertEquals(1, events.size)
        assertIs<TextMessageStartEvent>(events.first())
    }
}