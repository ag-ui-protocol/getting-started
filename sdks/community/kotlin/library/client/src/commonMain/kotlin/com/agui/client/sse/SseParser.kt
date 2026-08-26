package com.agui.client.sse

import com.agui.core.types.BaseEvent
import com.agui.core.types.AgUiJson
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.Json
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("SseParser")

/**
 * Parses a stream of SSE data into AG-UI events.
 * Each chunk received is already a complete JSON event from the SSE client.
 * Handles JSON deserialization and error recovery for malformed events.
 * 
 * @property json The JSON serializer instance used for parsing events
 */
class SseParser(
    private val json: Json = AgUiJson
) {
    /**
     * Transform raw JSON strings into parsed events.
     * Filters out malformed JSON events and logs parsing errors for debugging.
     * 
     * @param source Flow of raw JSON strings from the SSE stream
     * @return Flow<BaseEvent> stream of successfully parsed AG-UI events
     */
    fun parseFlow(source: Flow<String>): Flow<BaseEvent> = source.mapNotNull { jsonStr ->
        val trimmed = jsonStr.trim()
        if (exceedsMaxDepth(trimmed)) {
            // Refused before the parser sees it, rather than caught afterwards. The deserializer
            // descends recursively, so a payload nested far enough exhausts the stack, and what
            // that produces is not the same everywhere: a JVM StackOverflowError can be caught,
            // while on Kotlin/Native overflowing the native stack can take the process down with
            // no throwable to catch at all. Counting the nesting first is the only form of this
            // check that means anything on every target.
            logger.e { "Rejected JSON event nested deeper than $MAX_JSON_DEPTH levels" }
            return@mapNotNull null
        }
        try {
            val event = json.decodeFromString<BaseEvent>(trimmed)
            logger.d { "Successfully parsed event: ${event.eventType}" }
            event
        } catch (e: Exception) {
            logger.e(e) { "Failed to parse JSON event: $jsonStr" }
            null
        }
    }

    /**
     * Whether [json] nests containers deeper than [MAX_JSON_DEPTH].
     *
     * Iterative on purpose: a recursive depth check would fail in the same way as the parser it is
     * protecting. Braces and brackets inside string literals are not nesting, so the scan tracks
     * whether it is inside a string and honours backslash escapes; without that, a `data` field
     * containing `"[[[["` would be read as structure.
     */
    private fun exceedsMaxDepth(json: String): Boolean {
        var depth = 0
        var inString = false
        var escaped = false
        for (char in json) {
            if (escaped) {
                escaped = false
                continue
            }
            when {
                char == '\\' && inString -> escaped = true
                char == '"' -> inString = !inString
                inString -> {}
                char == '{' || char == '[' -> {
                    depth++
                    if (depth > MAX_JSON_DEPTH) return true
                }
                char == '}' || char == ']' -> depth--
            }
        }
        return false
    }

    companion object {
        /**
         * How deeply an event payload may nest containers.
         *
         * Well above anything the protocol itself produces — AG-UI events are a handful of levels
         * deep — and generous for the arbitrary customer JSON that rides in `state` snapshots and
         * deltas, while staying far below the depth that threatens any target's stack.
         */
        const val MAX_JSON_DEPTH: Int = 512
    }
}