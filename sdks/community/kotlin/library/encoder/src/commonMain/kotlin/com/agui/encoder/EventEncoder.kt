package com.agui.encoder

import com.agui.core.types.AgUiJson
import com.agui.core.types.BaseEvent
import kotlinx.serialization.encodeToString

/**
 * Encodes AG-UI [BaseEvent]s to the wire form. Mirrors the TypeScript
 * (`@ag-ui/encoder`) and Python (`ag_ui.encoder`) `EventEncoder`: construct per
 * request with the client's `Accept` header, then [encode] each event.
 *
 * SSE only for now (matching the Python encoder). Protobuf negotiation is a TODO
 * pending a Kotlin `@ag-ui/proto` codec — see [getContentType].
 */
class EventEncoder(private val accept: String? = null) {

    /** Mirrors TS/Python `getContentType()`. Always SSE for now (no Kotlin proto codec yet). */
    fun getContentType(): String = SSE_CONTENT_TYPE
    // TODO: negotiate AGUI_MEDIA_TYPE from `accept` once a Kotlin proto
    // codec exists, matching TS EventEncoder.getContentType()/encodeBinary().

    /** Mirrors TS/Python `encode()`. */
    fun encode(event: BaseEvent): String = encodeSSE(event)

    /** Canonical SSE framing: `data: {json}\n\n`. Mirrors TS `encodeSSE`. */
    fun encodeSSE(event: BaseEvent): String =
        "data: " + encodeToJson(event) + "\n\n"

    /**
     * The JSON wire body for [event], with **no** SSE framing.
     *
     * Use this from transports that add their own framing — e.g. Spring MVC's `SseEmitter` or
     * Jakarta's `SseEventSink`, which prefix `data:` and append the blank line themselves. Pairing
     * such a transport with [encode]/[encodeSSE] would double-frame the stream; hand it
     * [encodeToJson] instead so the SDK stays the single serialization entry point (no need for the
     * consumer to reach past the encoder to [AgUiJson]/`BaseEvent.serializer()` directly). For raw
     * byte streaming (FastAPI-style `StreamingResponse`, Ktor `respondBytesWriter`) use [encode].
     */
    fun encodeToJson(event: BaseEvent): String = AgUiJson.encodeToString(event)

    companion object {
        const val SSE_CONTENT_TYPE: String = "text/event-stream"
        const val AGUI_MEDIA_TYPE: String = "application/vnd.ag-ui.event+proto"
    }
}
