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

proc encodeSSE*(encoder: EventEncoder, event: BaseEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: TextMessageStartEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: TextMessageContentEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: TextMessageEndEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: ToolCallStartEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: ToolCallArgsEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: ToolCallEndEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: StateSnapshotEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: StateDeltaEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: MessagesSnapshotEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: RawEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: CustomEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: RunStartedEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: RunFinishedEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: RunErrorEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: StepStartedEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: StepFinishedEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: TextMessageChunkEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: ToolCallChunkEvent): string =
  let jsonStr = $event.toJson()
  result = fmt"data: {jsonStr}" & "\n\n"

proc encodeSSE*(encoder: EventEncoder, event: Event): string =
  case event.kind
  of EkTextMessageStart:
    encoder.encodeSSE(event.textMessageStart)
  of EkTextMessageContent:
    encoder.encodeSSE(event.textMessageContent)
  of EkTextMessageEnd:
    encoder.encodeSSE(event.textMessageEnd)
  of EkTextMessageChunk:
    encoder.encodeSSE(event.textMessageChunk)
  of EkToolCallStart:
    encoder.encodeSSE(event.toolCallStart)
  of EkToolCallArgs:
    encoder.encodeSSE(event.toolCallArgs)
  of EkToolCallEnd:
    encoder.encodeSSE(event.toolCallEnd)
  of EkToolCallChunk:
    encoder.encodeSSE(event.toolCallChunk)
  of EkStateSnapshot:
    encoder.encodeSSE(event.stateSnapshot)
  of EkStateDelta:
    encoder.encodeSSE(event.stateDelta)
  of EkMessagesSnapshot:
    encoder.encodeSSE(event.messagesSnapshot)
  of EkRaw:
    encoder.encodeSSE(event.raw)
  of EkCustom:
    encoder.encodeSSE(event.custom)
  of EkRunStarted:
    encoder.encodeSSE(event.runStarted)
  of EkRunFinished:
    encoder.encodeSSE(event.runFinished)
  of EkRunError:
    encoder.encodeSSE(event.runError)
  of EkStepStarted:
    encoder.encodeSSE(event.stepStarted)
  of EkStepFinished:
    encoder.encodeSSE(event.stepFinished)

proc encode*(encoder: EventEncoder, event: Event): string =
  encoder.encodeSSE(event)

proc encode*[T](encoder: EventEncoder, event: T): string =
  encoder.encodeSSE(event)

export newEventEncoder, getContentType, encode, encodeSSE