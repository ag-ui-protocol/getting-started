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
        try {
            val event = json.decodeFromString<BaseEvent>(jsonStr.trim())
            logger.d { "Successfully parsed event: ${event.eventType}" }
            event
        } catch (e: Exception) {
            logger.e(e) { "Failed to parse JSON event: $jsonStr" }
            null
        } catch (e: Error) {
            // A deeply nested payload makes the recursive descent JSON parser
            // raise StackOverflowError, which is an Error rather than an
            // Exception. Left uncaught it escapes the flow and tears down the
            // caller, so a single malformed event ends the whole stream.
            logger.e(e) { "Failed to parse JSON event: $jsonStr" }
            null
        }
    }
}