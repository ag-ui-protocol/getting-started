import ../core/events
import ../core/types
import strformat
import tables
import json
import options

type
  VerifyError* = object of CatchableError
  
  VerifyState = object
    activeMessageId: string
    activeToolCallId: string
    runFinished: bool
    runError: bool
    firstEventReceived: bool
    activeSteps: Table[string, bool]
    debug: bool

# Safe conversion functions
proc toRunStartedEvent(event: BaseEvent): RunStartedEvent =
  result = RunStartedEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("threadId"):
      result.threadId = rawJson["threadId"].getStr
    if rawJson.hasKey("runId"):
      result.runId = rawJson["runId"].getStr

proc toTextMessageStartEvent(event: BaseEvent): TextMessageStartEvent =
  result = TextMessageStartEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("messageId"):
      result.messageId = rawJson["messageId"].getStr
    if rawJson.hasKey("role"):
      result.role = rawJson["role"].getStr

proc toTextMessageContentEvent(event: BaseEvent): TextMessageContentEvent =
  result = TextMessageContentEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("messageId"):
      result.messageId = rawJson["messageId"].getStr
    if rawJson.hasKey("delta"):
      result.delta = rawJson["delta"].getStr

proc toTextMessageEndEvent(event: BaseEvent): TextMessageEndEvent =
  result = TextMessageEndEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("messageId"):
      result.messageId = rawJson["messageId"].getStr

proc toToolCallStartEvent(event: BaseEvent): ToolCallStartEvent =
  result = ToolCallStartEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("toolCallId"):
      result.toolCallId = rawJson["toolCallId"].getStr
    if rawJson.hasKey("toolCallName"):
      result.toolCallName = rawJson["toolCallName"].getStr
    if rawJson.hasKey("parentMessageId"):
      result.parentMessageId = some(rawJson["parentMessageId"].getStr)

proc toToolCallEndEvent(event: BaseEvent): ToolCallEndEvent =
  result = ToolCallEndEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("toolCallId"):
      result.toolCallId = rawJson["toolCallId"].getStr

proc toStepStartedEvent(event: BaseEvent): StepStartedEvent =
  result = StepStartedEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("stepName"):
      result.stepName = rawJson["stepName"].getStr

proc toStepFinishedEvent(event: BaseEvent): StepFinishedEvent =
  result = StepFinishedEvent()
  result.`type` = event.`type`
  result.timestamp = event.timestamp
  result.rawEvent = event.rawEvent
  if event.rawEvent.isSome:
    let rawJson = event.rawEvent.get
    if rawJson.hasKey("stepName"):
      result.stepName = rawJson["stepName"].getStr

proc verifyEvents*(events: seq[BaseEvent], debug: bool = false): seq[BaseEvent] =
  ## Verifies that events follow the AG-UI protocol rules
  var state = VerifyState(
    activeSteps: initTable[string, bool](),
    debug: debug
  )
  
  result = @[]
  
  for event in events:
    if state.debug:
      echo fmt"[VERIFY]: {event.type}"
    
    # Check if run has errored
    if state.runError:
      raise newException(VerifyError, 
        fmt"Cannot send event type '{event.type}': The run has already errored with 'RUN_ERROR'. No further events can be sent.")
    
    # Check if run has already finished
    if state.runFinished and event.type != EventType.RUN_ERROR:
      raise newException(VerifyError,
        fmt"Cannot send event type '{event.type}': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.")
    
    # Forbid lifecycle events and tool events inside a text message
    if state.activeMessageId != "":
      let allowedEventTypes = @[
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END
      ]
      
      if event.type notin allowedEventTypes:
        raise newException(VerifyError,
          fmt"Cannot send event type '{event.type}' inside a text message. Only TEXT_MESSAGE_CONTENT or TEXT_MESSAGE_END are allowed.")
    
    # Process event based on type
    case event.type
    of EventType.RUN_STARTED:
      if state.firstEventReceived:
        raise newException(VerifyError,
          "RUN_STARTED must be the first event")
      state.firstEventReceived = true
      
    of EventType.RUN_FINISHED:
      if not state.firstEventReceived:
        raise newException(VerifyError,
          "RUN_FINISHED cannot be sent before RUN_STARTED")
      state.runFinished = true
      
    of EventType.RUN_ERROR:
      if not state.firstEventReceived:
        raise newException(VerifyError,
          "RUN_ERROR cannot be sent before RUN_STARTED")
      state.runError = true
      
    of EventType.TEXT_MESSAGE_START:
      if state.activeMessageId != "":
        raise newException(VerifyError,
          "Cannot start a new text message while another is active")
      let startEvent = toTextMessageStartEvent(event)
      state.activeMessageId = startEvent.messageId
      
    of EventType.TEXT_MESSAGE_CONTENT:
      if state.activeMessageId == "":
        raise newException(VerifyError,
          "Cannot add content to a text message without an active message")
      let contentEvent = toTextMessageContentEvent(event)
      if contentEvent.messageId != state.activeMessageId:
        raise newException(VerifyError,
          fmt"Message ID mismatch: content for {contentEvent.messageId} but active is {state.activeMessageId}")
      
    of EventType.TEXT_MESSAGE_END:
      if state.activeMessageId == "":
        raise newException(VerifyError,
          "Cannot end a text message without an active message")
      let endEvent = toTextMessageEndEvent(event)
      if endEvent.messageId != state.activeMessageId:
        raise newException(VerifyError,
          fmt"Message ID mismatch: ending {endEvent.messageId} but active is {state.activeMessageId}")
      state.activeMessageId = ""
      
    of EventType.TOOL_CALL_START:
      if state.activeToolCallId != "":
        raise newException(VerifyError,
          "Cannot start a new tool call while another is active")
      let startEvent = toToolCallStartEvent(event)
      state.activeToolCallId = startEvent.toolCallId
      
    of EventType.TOOL_CALL_END:
      if state.activeToolCallId == "":
        raise newException(VerifyError,
          "Cannot end a tool call without an active tool call")
      let endEvent = toToolCallEndEvent(event)
      if endEvent.toolCallId != state.activeToolCallId:
        raise newException(VerifyError,
          fmt"Tool call ID mismatch: ending {endEvent.toolCallId} but active is {state.activeToolCallId}")
      state.activeToolCallId = ""
      
    of EventType.STEP_STARTED:
      let stepEvent = toStepStartedEvent(event)
      if state.activeSteps.hasKey(stepEvent.stepName):
        raise newException(VerifyError,
          fmt"Step '{stepEvent.stepName}' is already active")
      state.activeSteps[stepEvent.stepName] = true
      
    of EventType.STEP_FINISHED:
      let stepEvent = toStepFinishedEvent(event)
      if not state.activeSteps.hasKey(stepEvent.stepName):
        raise newException(VerifyError,
          fmt"Step '{stepEvent.stepName}' is not active")
      state.activeSteps.del(stepEvent.stepName)
      
    else:
      discard
    
    result.add(event)
  
  # Final state checks
  if state.activeMessageId != "":
    raise newException(VerifyError,
      "Text message was not properly closed")
  
  if state.activeToolCallId != "":
    raise newException(VerifyError,
      "Tool call was not properly closed")
  
  if state.activeSteps.len > 0:
    var activeStepNames: seq[string] = @[]
    for stepName in state.activeSteps.keys:
      activeStepNames.add(stepName)
    raise newException(VerifyError,
      fmt"Steps not properly closed: {activeStepNames}")