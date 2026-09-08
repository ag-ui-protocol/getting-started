import std/[json, strformat]
import ../core/events

const AGUI_MEDIA_TYPE* = "application/vnd.ag-ui.event+proto"

type
  EventEncoder* = object
    acceptsProtobuf: bool

proc newEventEncoder*(accept: string = ""): EventEncoder =
  EventEncoder(acceptsProtobuf: false)

proc getContentType*(encoder: EventEncoder): string =
  if encoder.acceptsProtobuf:
    return AGUI_MEDIA_TYPE
  else:
    return "text/event-stream"

proc encodeSSE*[T](encoder: EventEncoder, event: T): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encode*(encoder: EventEncoder, event: Event): string =
  encoder.encodeSSE(event)

proc encode*[T](encoder: EventEncoder, event: T): string =
  encoder.encodeSSE(event)

export newEventEncoder, getContentType, encode, encodeSSE