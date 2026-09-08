import std/[options, json, tables, times]
import ./types

type
  EventType* = enum
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK"
    THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START"
    THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT"
    THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK"
    TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
    THINKING_START = "THINKING_START"
    THINKING_END = "THINKING_END"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"
    MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"
    ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT"
    ACTIVITY_DELTA = "ACTIVITY_DELTA"
    RAW = "RAW"
    CUSTOM = "CUSTOM"
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"
    REASONING_START = "REASONING_START"
    REASONING_MESSAGE_START = "REASONING_MESSAGE_START"
    REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT"
    REASONING_MESSAGE_END = "REASONING_MESSAGE_END"
    REASONING_MESSAGE_CHUNK = "REASONING_MESSAGE_CHUNK"
    REASONING_END = "REASONING_END"
    REASONING_ENCRYPTED_VALUE = "REASONING_ENCRYPTED_VALUE"

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

  TextMessageChunkEvent* = object of BaseEvent
    messageId*: Option[string]
    role*: Option[string]
    delta*: Option[string]
  
  ThinkingTextMessageStartEvent* = object of BaseEvent

  ThinkingTextMessageContentEvent* = object of BaseEvent
    delta*: string

  ThinkingTextMessageEndEvent* = object of BaseEvent

  ToolCallStartEvent* = object of BaseEvent
    toolCallId*: string
    toolCallName*: string
    parentMessageId*: Option[string]

  ToolCallArgsEvent* = object of BaseEvent
    toolCallId*: string
    delta*: string

  ToolCallEndEvent* = object of BaseEvent
    toolCallId*: string

  ToolCallChunkEvent* = object of BaseEvent
    toolCallId*: Option[string]
    toolCallName*: Option[string]
    parentMessageId*: Option[string]
    delta*: Option[string]

  ToolCallResultEvent* = object of BaseEvent
    messageId*: string
    toolCallId*: string
    content*: string
    role*: Option[string]

  ThinkingStartEvent* = object of BaseEvent
    title*: Option[string]

  ThinkingEndEvent* = object of BaseEvent

  StateSnapshotEvent* = object of BaseEvent
    snapshot*: State

  StateDeltaEvent* = object of BaseEvent
    delta*: seq[JsonNode]

  MessagesSnapshotEvent* = object of BaseEvent
    messages*: seq[Message]

  ActivitySnapshotEvent* = object of BaseEvent
    messageId*: string
    activityType*: string
    content*: JsonNode
    replace*: bool

  ActivityDeltaEvent* = object of BaseEvent
    messageId*: string
    activityType*: string
    patch*: seq[JsonNode]

  RawEvent* = object of BaseEvent
    event*: JsonNode
    source*: Option[string]

  CustomEvent* = object of BaseEvent
    name*: string
    value*: JsonNode

  RunStartedEvent* = object of BaseEvent
    threadId*: string
    runId*: string
    parentRunId*: Option[string]
    input*: Option[RunAgentInput]

  RunFinishedEvent* = object of BaseEvent
    threadId*: string
    runId*: string
    result*: Option[JsonNode]

  RunErrorEvent* = object of BaseEvent
    message*: string
    code*: Option[string]

  StepStartedEvent* = object of BaseEvent
    stepName*: string

  StepFinishedEvent* = object of BaseEvent
    stepName*: string

  ReasoningStartEvent* = object of BaseEvent
    messageId*: string

  ReasoningMessageStartEvent* = object of BaseEvent
    messageId*: string
    role*: string

  ReasoningMessageContentEvent* = object of BaseEvent
    messageId*: string
    delta*: string

  ReasoningMessageEndEvent* = object of BaseEvent
    messageId*: string

  ReasoningMessageChunkEvent* = object of BaseEvent
    messageId*: Option[string]
    delta*: Option[string]

  ReasoningEndEvent* = object of BaseEvent
    messageId*: string

  ReasoningEncryptedValueEvent* = object of BaseEvent
    subtype*: string
    entityId*: string
    encryptedValue*: string

  EventKind* = enum
    EkTextMessageStart
    EkTextMessageContent
    EkTextMessageEnd
    EkTextMessageChunk
    EkThinkingTextMessageStart
    EkThinkingTextMessageContent
    EkThinkingTextMessageEnd
    EkToolCallStart
    EkToolCallArgs
    EkToolCallEnd
    EkToolCallChunk
    EkToolCallResult
    EkThinkingStart
    EkThinkingEnd
    EkStateSnapshot
    EkStateDelta
    EkMessagesSnapshot
    EkActivitySnapshot
    EkActivityDelta
    EkRaw
    EkCustom
    EkRunStarted
    EkRunFinished
    EkRunError
    EkStepStarted
    EkStepFinished
    EkReasoningStart
    EkReasoningMessageStart
    EkReasoningMessageContent
    EkReasoningMessageEnd
    EkReasoningMessageChunk
    EkReasoningEnd
    EkReasoningEncryptedValue

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
    of EkThinkingTextMessageStart:
      thinkingTextMessageStart*: ThinkingTextMessageStartEvent
    of EkThinkingTextMessageContent:
      thinkingTextMessageContent*: ThinkingTextMessageContentEvent
    of EkThinkingTextMessageEnd:
      thinkingTextMessageEnd*: ThinkingTextMessageEndEvent
    of EkToolCallStart:
      toolCallStart*: ToolCallStartEvent
    of EkToolCallArgs:
      toolCallArgs*: ToolCallArgsEvent
    of EkToolCallEnd:
      toolCallEnd*: ToolCallEndEvent
    of EkToolCallChunk:
      toolCallChunk*: ToolCallChunkEvent
    of EkToolCallResult:
      toolCallResult*: ToolCallResultEvent
    of EkThinkingStart:
      thinkingStart*: ThinkingStartEvent
    of EkThinkingEnd:
      thinkingEnd*: ThinkingEndEvent
    of EkStateSnapshot:
      stateSnapshot*: StateSnapshotEvent
    of EkStateDelta:
      stateDelta*: StateDeltaEvent
    of EkMessagesSnapshot:
      messagesSnapshot*: MessagesSnapshotEvent
    of EkActivitySnapshot:
      activitySnapshot*: ActivitySnapshotEvent
    of EkActivityDelta:
      activityDelta*: ActivityDeltaEvent
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
    of EkReasoningStart:
      reasoningStart*: ReasoningStartEvent
    of EkReasoningMessageStart:
      reasoningMessageStart*: ReasoningMessageStartEvent
    of EkReasoningMessageContent:
      reasoningMessageContent*: ReasoningMessageContentEvent
    of EkReasoningMessageEnd:
      reasoningMessageEnd*: ReasoningMessageEndEvent
    of EkReasoningMessageChunk:
      reasoningMessageChunk*: ReasoningMessageChunkEvent
    of EkReasoningEnd:
      reasoningEnd*: ReasoningEndEvent
    of EkReasoningEncryptedValue:
      reasoningEncryptedValue*: ReasoningEncryptedValueEvent

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
                         parentRunId: Option[string] = none(string),
                         input: Option[RunAgentInput] = none(RunAgentInput),
                         timestamp: Option[int64] = none(int64),
                         rawEvent: Option[JsonNode] = none(JsonNode)): RunStartedEvent =
  result = RunStartedEvent()
  result.`type` = RUN_STARTED
  result.threadId = threadId
  result.runId = runId
  result.parentRunId = parentRunId
  result.input = input
  result.timestamp = timestamp
  result.rawEvent = rawEvent

proc newRunFinishedEvent*(threadId: string, runId: string,
                          result_data: Option[JsonNode] = none(JsonNode),
                          timestamp: Option[int64] = none(int64),
                          rawEvent: Option[JsonNode] = none(JsonNode)): RunFinishedEvent =
  result = RunFinishedEvent()
  result.`type` = RUN_FINISHED
  result.threadId = threadId
  result.runId = runId
  result.result = result_data
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

# JSON Conversion Helpers
proc addBaseFields(result: JsonNode, event: BaseEvent) =
  result["type"] = %($event.`type`)
  if event.timestamp.isSome:
    result["timestamp"] = %event.timestamp.get
  if event.rawEvent.isSome:
    result["rawEvent"] = event.rawEvent.get

proc toJson*(event: TextMessageStartEvent): JsonNode =
  result = %*{
    "messageId": event.messageId,
    "role": event.role
  }
  addBaseFields(result, event)

proc toJson*(event: TextMessageContentEvent): JsonNode =
  result = %*{
    "messageId": event.messageId,
    "delta": event.delta
  }
  addBaseFields(result, event)

proc toJson*(event: TextMessageEndEvent): JsonNode =
  result = %*{
    "messageId": event.messageId
  }
  addBaseFields(result, event)

proc toJson*(event: TextMessageChunkEvent): JsonNode =
  result = newJObject()
  if event.messageId.isSome: result["messageId"] = %event.messageId.get
  if event.role.isSome: result["role"] = %event.role.get
  if event.delta.isSome: result["delta"] = %event.delta.get
  addBaseFields(result, event)

proc toJson*(event: ThinkingTextMessageStartEvent): JsonNode =
  result = newJObject()
  addBaseFields(result, event)

proc toJson*(event: ThinkingTextMessageContentEvent): JsonNode =
  result = %*{"delta": event.delta}
  addBaseFields(result, event)

proc toJson*(event: ThinkingTextMessageEndEvent): JsonNode =
  result = newJObject()
  addBaseFields(result, event)

proc toJson*(event: ToolCallStartEvent): JsonNode =
  result = %*{
    "toolCallId": event.toolCallId,
    "toolCallName": event.toolCallName
  }
  if event.parentMessageId.isSome:
    result["parentMessageId"] = %event.parentMessageId.get
  addBaseFields(result, event)

proc toJson*(event: ToolCallArgsEvent): JsonNode =
  result = %*{
    "toolCallId": event.toolCallId,
    "delta": event.delta
  }
  addBaseFields(result, event)

proc toJson*(event: ToolCallEndEvent): JsonNode =
  result = %*{
    "toolCallId": event.toolCallId
  }
  addBaseFields(result, event)

proc toJson*(event: ToolCallChunkEvent): JsonNode =
  result = newJObject()
  if event.toolCallId.isSome: result["toolCallId"] = %event.toolCallId.get
  if event.toolCallName.isSome: result["toolCallName"] = %event.toolCallName.get
  if event.parentMessageId.isSome: result["parentMessageId"] = %event.parentMessageId.get
  if event.delta.isSome: result["delta"] = %event.delta.get
  addBaseFields(result, event)

proc toJson*(event: ToolCallResultEvent): JsonNode =
  result = %*{
    "messageId": event.messageId,
    "toolCallId": event.toolCallId,
    "content": event.content
  }
  if event.role.isSome: result["role"] = %event.role.get
  addBaseFields(result, event)

proc toJson*(event: ThinkingStartEvent): JsonNode =
  result = newJObject()
  if event.title.isSome: result["title"] = %event.title.get
  addBaseFields(result, event)

proc toJson*(event: ThinkingEndEvent): JsonNode =
  result = newJObject()
  addBaseFields(result, event)

proc toJson*(event: StateSnapshotEvent): JsonNode =
  result = %*{
    "snapshot": event.snapshot
  }
  addBaseFields(result, event)

proc toJson*(event: StateDeltaEvent): JsonNode =
  result = %*{
    "delta": event.delta
  }
  addBaseFields(result, event)

proc toJson*(event: MessagesSnapshotEvent): JsonNode =
  result = newJObject()
  let messagesJson = newJArray()
  for msg in event.messages:
    messagesJson.add(msg.toJson())
  result["messages"] = messagesJson
  addBaseFields(result, event)

proc toJson*(event: ActivitySnapshotEvent): JsonNode =
  result = %*{
    "messageId": event.messageId,
    "activityType": event.activityType,
    "content": event.content,
    "replace": event.replace
  }
  addBaseFields(result, event)

proc toJson*(event: ActivityDeltaEvent): JsonNode =
  result = %*{
    "messageId": event.messageId,
    "activityType": event.activityType,
    "patch": event.patch
  }
  addBaseFields(result, event)

proc toJson*(event: RawEvent): JsonNode =
  result = %*{
    "event": event.event
  }
  if event.source.isSome:
    result["source"] = %event.source.get
  addBaseFields(result, event)

proc toJson*(event: CustomEvent): JsonNode =
  result = %*{
    "name": event.name,
    "value": event.value
  }
  addBaseFields(result, event)

proc toJson*(event: RunStartedEvent): JsonNode =
  result = %*{
    "threadId": event.threadId,
    "runId": event.runId
  }
  if event.parentRunId.isSome:
    result["parentRunId"] = %event.parentRunId.get
  if event.input.isSome:
    result["input"] = event.input.get.toJson()
  addBaseFields(result, event)

proc toJson*(event: RunFinishedEvent): JsonNode =
  result = %*{
    "threadId": event.threadId,
    "runId": event.runId
  }
  if event.result.isSome:
    result["result"] = event.result.get
  addBaseFields(result, event)

proc toJson*(event: RunErrorEvent): JsonNode =
  result = %*{
    "message": event.message
  }
  if event.code.isSome:
    result["code"] = %event.code.get
  addBaseFields(result, event)

proc toJson*(event: StepStartedEvent): JsonNode =
  result = %*{
    "stepName": event.stepName
  }
  addBaseFields(result, event)

proc toJson*(event: StepFinishedEvent): JsonNode =
  result = %*{
    "stepName": event.stepName
  }
  addBaseFields(result, event)

proc toJson*(event: ReasoningStartEvent): JsonNode =
  result = %*{"messageId": event.messageId}
  addBaseFields(result, event)

proc toJson*(event: ReasoningMessageStartEvent): JsonNode =
  result = %*{
    "messageId": event.messageId,
    "role": event.role
  }
  addBaseFields(result, event)

proc toJson*(event: ReasoningMessageContentEvent): JsonNode =
  result = %*{
    "messageId": event.messageId,
    "delta": event.delta
  }
  addBaseFields(result, event)

proc toJson*(event: ReasoningMessageEndEvent): JsonNode =
  result = %*{"messageId": event.messageId}
  addBaseFields(result, event)

proc toJson*(event: ReasoningMessageChunkEvent): JsonNode =
  result = newJObject()
  if event.messageId.isSome: result["messageId"] = %event.messageId.get
  if event.delta.isSome: result["delta"] = %event.delta.get
  addBaseFields(result, event)

proc toJson*(event: ReasoningEndEvent): JsonNode =
  result = %*{"messageId": event.messageId}
  addBaseFields(result, event)

proc toJson*(event: ReasoningEncryptedValueEvent): JsonNode =
  result = %*{
    "subtype": event.subtype,
    "entityId": event.entityId,
    "encryptedValue": event.encryptedValue
  }
  addBaseFields(result, event)

proc toJson*(event: Event): JsonNode =
  case event.kind
  of EkTextMessageStart: event.textMessageStart.toJson()
  of EkTextMessageContent: event.textMessageContent.toJson()
  of EkTextMessageEnd: event.textMessageEnd.toJson()
  of EkTextMessageChunk: event.textMessageChunk.toJson()
  of EkThinkingTextMessageStart: event.thinkingTextMessageStart.toJson()
  of EkThinkingTextMessageContent: event.thinkingTextMessageContent.toJson()
  of EkThinkingTextMessageEnd: event.thinkingTextMessageEnd.toJson()
  of EkToolCallStart: event.toolCallStart.toJson()
  of EkToolCallArgs: event.toolCallArgs.toJson()
  of EkToolCallEnd: event.toolCallEnd.toJson()
  of EkToolCallChunk: event.toolCallChunk.toJson()
  of EkToolCallResult: event.toolCallResult.toJson()
  of EkThinkingStart: event.thinkingStart.toJson()
  of EkThinkingEnd: event.thinkingEnd.toJson()
  of EkStateSnapshot: event.stateSnapshot.toJson()
  of EkStateDelta: event.stateDelta.toJson()
  of EkMessagesSnapshot: event.messagesSnapshot.toJson()
  of EkActivitySnapshot: event.activitySnapshot.toJson()
  of EkActivityDelta: event.activityDelta.toJson()
  of EkRaw: event.raw.toJson()
  of EkCustom: event.custom.toJson()
  of EkRunStarted: event.runStarted.toJson()
  of EkRunFinished: event.runFinished.toJson()
  of EkRunError: event.runError.toJson()
  of EkStepStarted: event.stepStarted.toJson()
  of EkStepFinished: event.stepFinished.toJson()
  of EkReasoningStart: event.reasoningStart.toJson()
  of EkReasoningMessageStart: event.reasoningMessageStart.toJson()
  of EkReasoningMessageContent: event.reasoningMessageContent.toJson()
  of EkReasoningMessageEnd: event.reasoningMessageEnd.toJson()
  of EkReasoningMessageChunk: event.reasoningMessageChunk.toJson()
  of EkReasoningEnd: event.reasoningEnd.toJson()
  of EkReasoningEncryptedValue: event.reasoningEncryptedValue.toJson()

export toJson