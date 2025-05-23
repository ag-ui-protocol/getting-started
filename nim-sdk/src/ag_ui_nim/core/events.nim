import std/[options, json, tables, times]
import ./types

type
  EventType* = enum
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"
    MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"
    RAW = "RAW"
    CUSTOM = "CUSTOM"
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"

  BaseEvent* = object of RootObj
    `type`*: EventType
    timestamp*: Option[int64]
    rawEvent*: Option[JsonNode]

  TextMessageStartEvent* = object of BaseEvent
    messageId*: string
    role*: string

  TextMessageContentEvent* = object of BaseEvent
    messageId*: string
    delta*: string

  TextMessageEndEvent* = object of BaseEvent
    messageId*: string

  ToolCallStartEvent* = object of BaseEvent
    toolCallId*: string
    toolCallName*: string
    parentMessageId*: Option[string]

  ToolCallArgsEvent* = object of BaseEvent
    toolCallId*: string
    delta*: string

  ToolCallEndEvent* = object of BaseEvent
    toolCallId*: string

  StateSnapshotEvent* = object of BaseEvent
    snapshot*: State

  StateDeltaEvent* = object of BaseEvent
    delta*: seq[JsonNode]

  MessagesSnapshotEvent* = object of BaseEvent
    messages*: seq[Message]

  RawEvent* = object of BaseEvent
    event*: JsonNode
    source*: Option[string]

  CustomEvent* = object of BaseEvent
    name*: string
    value*: JsonNode

  RunStartedEvent* = object of BaseEvent
    threadId*: string
    runId*: string

  RunFinishedEvent* = object of BaseEvent
    threadId*: string
    runId*: string

  RunErrorEvent* = object of BaseEvent
    message*: string
    code*: Option[string]

  StepStartedEvent* = object of BaseEvent
    stepName*: string

  StepFinishedEvent* = object of BaseEvent
    stepName*: string

  TextMessageChunkEvent* = object of BaseEvent
    messageId*: string
    role*: string
    content*: string
  
  ToolCallChunkEvent* = object of BaseEvent
    toolCallId*: string
    toolCallName*: string
    parentMessageId*: Option[string]
    args*: string

  EventKind* = enum
    EkTextMessageStart
    EkTextMessageContent
    EkTextMessageEnd
    EkTextMessageChunk
    EkToolCallStart
    EkToolCallArgs
    EkToolCallEnd
    EkToolCallChunk
    EkStateSnapshot
    EkStateDelta
    EkMessagesSnapshot
    EkRaw
    EkCustom
    EkRunStarted
    EkRunFinished
    EkRunError
    EkStepStarted
    EkStepFinished

  Event* = object
    case kind*: EventKind
    of EkTextMessageStart:
      textMessageStart*: TextMessageStartEvent
    of EkTextMessageContent:
      textMessageContent*: TextMessageContentEvent
    of EkTextMessageEnd:
      textMessageEnd*: TextMessageEndEvent
    of EkTextMessageChunk:
      textMessageChunk*: TextMessageChunkEvent
    of EkToolCallStart:
      toolCallStart*: ToolCallStartEvent
    of EkToolCallArgs:
      toolCallArgs*: ToolCallArgsEvent
    of EkToolCallEnd:
      toolCallEnd*: ToolCallEndEvent
    of EkToolCallChunk:
      toolCallChunk*: ToolCallChunkEvent
    of EkStateSnapshot:
      stateSnapshot*: StateSnapshotEvent
    of EkStateDelta:
      stateDelta*: StateDeltaEvent
    of EkMessagesSnapshot:
      messagesSnapshot*: MessagesSnapshotEvent
    of EkRaw:
      raw*: RawEvent
    of EkCustom:
      custom*: CustomEvent
    of EkRunStarted:
      runStarted*: RunStartedEvent
    of EkRunFinished:
      runFinished*: RunFinishedEvent
    of EkRunError:
      runError*: RunErrorEvent
    of EkStepStarted:
      stepStarted*: StepStartedEvent
    of EkStepFinished:
      stepFinished*: StepFinishedEvent

# Constructor functions
proc newTextMessageStartEvent*(messageId: string, role: string = "assistant", 
                               timestamp: Option[int64] = none(int64),
                               rawEvent: Option[JsonNode] = none(JsonNode)): TextMessageStartEvent =
  result = TextMessageStartEvent()
  result.`type` = TEXT_MESSAGE_START
  result.messageId = messageId
  result.role = role
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newTextMessageContentEvent*(messageId: string, delta: string,
                                 timestamp: Option[int64] = none(int64),
                                 rawEvent: Option[JsonNode] = none(JsonNode)): TextMessageContentEvent =
  if delta.len == 0:
    raise newException(ValueError, "Delta must not be an empty string")
  result = TextMessageContentEvent()
  result.`type` = TEXT_MESSAGE_CONTENT
  result.messageId = messageId
  result.delta = delta
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newTextMessageEndEvent*(messageId: string,
                             timestamp: Option[int64] = none(int64),
                             rawEvent: Option[JsonNode] = none(JsonNode)): TextMessageEndEvent =
  result = TextMessageEndEvent()
  result.`type` = TEXT_MESSAGE_END
  result.messageId = messageId
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newToolCallStartEvent*(toolCallId: string, toolCallName: string,
                            parentMessageId: Option[string] = none(string),
                            timestamp: Option[int64] = none(int64),
                            rawEvent: Option[JsonNode] = none(JsonNode)): ToolCallStartEvent =
  result = ToolCallStartEvent()
  result.`type` = TOOL_CALL_START
  result.toolCallId = toolCallId
  result.toolCallName = toolCallName
  result.parentMessageId = parentMessageId
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newToolCallArgsEvent*(toolCallId: string, delta: string,
                           timestamp: Option[int64] = none(int64),
                           rawEvent: Option[JsonNode] = none(JsonNode)): ToolCallArgsEvent =
  result = ToolCallArgsEvent()
  result.`type` = TOOL_CALL_ARGS
  result.toolCallId = toolCallId
  result.delta = delta
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newToolCallEndEvent*(toolCallId: string,
                          timestamp: Option[int64] = none(int64),
                          rawEvent: Option[JsonNode] = none(JsonNode)): ToolCallEndEvent =
  result = ToolCallEndEvent()
  result.`type` = TOOL_CALL_END
  result.toolCallId = toolCallId
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newStateSnapshotEvent*(snapshot: State,
                            timestamp: Option[int64] = none(int64),
                            rawEvent: Option[JsonNode] = none(JsonNode)): StateSnapshotEvent =
  result = StateSnapshotEvent()
  result.`type` = STATE_SNAPSHOT
  result.snapshot = snapshot
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newStateDeltaEvent*(delta: seq[JsonNode],
                         timestamp: Option[int64] = none(int64),
                         rawEvent: Option[JsonNode] = none(JsonNode)): StateDeltaEvent =
  result = StateDeltaEvent()
  result.`type` = STATE_DELTA
  result.delta = delta
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newMessagesSnapshotEvent*(messages: seq[Message],
                               timestamp: Option[int64] = none(int64),
                               rawEvent: Option[JsonNode] = none(JsonNode)): MessagesSnapshotEvent =
  result = MessagesSnapshotEvent()
  result.`type` = MESSAGES_SNAPSHOT
  result.messages = messages
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newRawEvent*(event: JsonNode, source: Option[string] = none(string),
                  timestamp: Option[int64] = none(int64),
                  rawEvent: Option[JsonNode] = none(JsonNode)): RawEvent =
  result = RawEvent()
  result.`type` = RAW
  result.event = event
  result.source = source
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newCustomEvent*(name: string, value: JsonNode,
                     timestamp: Option[int64] = none(int64),
                     rawEvent: Option[JsonNode] = none(JsonNode)): CustomEvent =
  result = CustomEvent()
  result.`type` = CUSTOM
  result.name = name
  result.value = value
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newRunStartedEvent*(threadId: string, runId: string,
                         timestamp: Option[int64] = none(int64),
                         rawEvent: Option[JsonNode] = none(JsonNode)): RunStartedEvent =
  result = RunStartedEvent()
  result.`type` = RUN_STARTED
  result.threadId = threadId
  result.runId = runId
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newRunFinishedEvent*(threadId: string, runId: string,
                          timestamp: Option[int64] = none(int64),
                          rawEvent: Option[JsonNode] = none(JsonNode)): RunFinishedEvent =
  result = RunFinishedEvent()
  result.`type` = RUN_FINISHED
  result.threadId = threadId
  result.runId = runId
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newRunErrorEvent*(message: string, code: Option[string] = none(string),
                       timestamp: Option[int64] = none(int64),
                       rawEvent: Option[JsonNode] = none(JsonNode)): RunErrorEvent =
  result = RunErrorEvent()
  result.`type` = RUN_ERROR
  result.message = message
  result.code = code
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newStepStartedEvent*(stepName: string,
                          timestamp: Option[int64] = none(int64),
                          rawEvent: Option[JsonNode] = none(JsonNode)): StepStartedEvent =
  result = StepStartedEvent()
  result.`type` = STEP_STARTED
  result.stepName = stepName
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newStepFinishedEvent*(stepName: string,
                           timestamp: Option[int64] = none(int64),
                           rawEvent: Option[JsonNode] = none(JsonNode)): StepFinishedEvent =
  result = StepFinishedEvent()
  result.`type` = STEP_FINISHED
  result.stepName = stepName
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newTextMessageChunkEvent*(messageId: string, role: string, content: string,
                              timestamp: Option[int64] = none(int64),
                              rawEvent: Option[JsonNode] = none(JsonNode)): TextMessageChunkEvent =
  result = TextMessageChunkEvent()
  result.`type` = TEXT_MESSAGE_CHUNK
  result.messageId = messageId
  result.role = role
  result.content = content
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newToolCallChunkEvent*(toolCallId: string, toolCallName: string, 
                           parentMessageId: string, args: string,
                           timestamp: Option[int64] = none(int64),
                           rawEvent: Option[JsonNode] = none(JsonNode)): ToolCallChunkEvent =
  result = ToolCallChunkEvent()
  result.`type` = TOOL_CALL_CHUNK
  result.toolCallId = toolCallId
  result.toolCallName = toolCallName
  result.parentMessageId = some(parentMessageId)
  result.args = args
  result.timestamp = timestamp
  result.rawEvent = rawEvent

# JSON Conversion
proc toJson*(event: BaseEvent): JsonNode =
  result = %*{
    "type": $event.`type`
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: TextMessageStartEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "messageId": event.messageId,
    "role": event.role
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: TextMessageContentEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "messageId": event.messageId,
    "delta": event.delta
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: TextMessageEndEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "messageId": event.messageId
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: ToolCallStartEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "toolCallId": event.toolCallId,
    "toolCallName": event.toolCallName
  }
  if event.parentMessageId.isSome:
    result["parentMessageId"] = %event.parentMessageId.get
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: ToolCallArgsEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "toolCallId": event.toolCallId,
    "delta": event.delta
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: ToolCallEndEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "toolCallId": event.toolCallId
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: StateSnapshotEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "snapshot": event.snapshot
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: StateDeltaEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "delta": event.delta
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: MessagesSnapshotEvent): JsonNode =
  result = %*{
    "type": $event.`type`
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get
  let messagesJson = newJArray()
  for msg in event.messages:
    messagesJson.add(msg.toJson())
  result["messages"] = messagesJson

proc toJson*(event: RawEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "event": event.event
  }
  if event.source.isSome:
    result["source"] = %event.source.get
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: CustomEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "name": event.name,
    "value": event.value
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: RunStartedEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "threadId": event.threadId,
    "runId": event.runId
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: RunFinishedEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "threadId": event.threadId,
    "runId": event.runId
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: RunErrorEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "message": event.message
  }
  if event.code.isSome:
    result["code"] = %event.code.get
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: StepStartedEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "stepName": event.stepName
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: StepFinishedEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "stepName": event.stepName
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: TextMessageChunkEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "messageId": event.messageId,
    "role": event.role,
    "content": event.content
  }
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: ToolCallChunkEvent): JsonNode =
  result = %*{
    "type": $event.`type`,
    "toolCallId": event.toolCallId,
    "toolCallName": event.toolCallName,
    "args": event.args
  }
  if event.parentMessageId.isSome:
    result["parentMessageId"] = %event.parentMessageId.get
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: Event): JsonNode =
  case event.kind
  of EkTextMessageStart:
    event.textMessageStart.toJson()
  of EkTextMessageContent:
    event.textMessageContent.toJson()
  of EkTextMessageEnd:
    event.textMessageEnd.toJson()
  of EkTextMessageChunk:
    event.textMessageChunk.toJson()
  of EkToolCallStart:
    event.toolCallStart.toJson()
  of EkToolCallArgs:
    event.toolCallArgs.toJson()
  of EkToolCallEnd:
    event.toolCallEnd.toJson()
  of EkToolCallChunk:
    event.toolCallChunk.toJson()
  of EkStateSnapshot:
    event.stateSnapshot.toJson()
  of EkStateDelta:
    event.stateDelta.toJson()
  of EkMessagesSnapshot:
    event.messagesSnapshot.toJson()
  of EkRaw:
    event.raw.toJson()
  of EkCustom:
    event.custom.toJson()
  of EkRunStarted:
    event.runStarted.toJson()
  of EkRunFinished:
    event.runFinished.toJson()
  of EkRunError:
    event.runError.toJson()
  of EkStepStarted:
    event.stepStarted.toJson()
  of EkStepFinished:
    event.stepFinished.toJson()

export toJson