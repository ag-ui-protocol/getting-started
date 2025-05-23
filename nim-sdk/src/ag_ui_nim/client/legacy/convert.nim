import ../../core/events
import ../../core/types
import ../../core/observable
import ./types
import json
import options
import strformat

type
  LegacyConvertState = object
    currentState: JsonNode
    threadId: string
    runId: string

proc convertToLegacyEvent*(event: BaseEvent, threadId: string, runId: string): Option[LegacyRuntimeProtocolEvent] =
  ## Convert a standard AG-UI event to a legacy runtime protocol event
  case event.type
  of EventType.TEXT_MESSAGE_START:
    let e = cast[TextMessageStartEvent](event)
    let legacyEvent = LegacyTextMessageStart(
      threadId: threadId,
      runId: runId,
      messageId: e.messageId,
      role: e.role
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: TextMessageStart,
      textMessageStart: legacyEvent
    ))
  
  of EventType.TEXT_MESSAGE_CONTENT:
    let e = cast[TextMessageContentEvent](event)
    let legacyEvent = LegacyTextMessageContent(
      threadId: threadId,
      runId: runId,
      messageId: e.messageId,
      content: e.delta
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: TextMessageContent,
      textMessageContent: legacyEvent
    ))
  
  of EventType.TEXT_MESSAGE_END:
    let e = cast[TextMessageEndEvent](event)
    let legacyEvent = LegacyTextMessageEnd(
      threadId: threadId,
      runId: runId,
      messageId: e.messageId
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: TextMessageEnd,
      textMessageEnd: legacyEvent
    ))
  
  of EventType.TOOL_CALL_START:
    let e = cast[ToolCallStartEvent](event)
    let legacyEvent = LegacyActionExecutionStart(
      threadId: threadId,
      runId: runId,
      actionId: e.toolCallId,
      action: e.toolCallName
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: ActionExecutionStart,
      actionExecutionStart: legacyEvent
    ))
  
  of EventType.TOOL_CALL_ARGS:
    let e = cast[ToolCallArgsEvent](event)
    let legacyEvent = LegacyActionExecutionArgs(
      threadId: threadId,
      runId: runId,
      actionId: e.toolCallId,
      args: e.delta
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: ActionExecutionArgs,
      actionExecutionArgs: legacyEvent
    ))
  
  of EventType.TOOL_CALL_END:
    let e = cast[ToolCallEndEvent](event)
    let legacyEvent = LegacyActionExecutionEnd(
      threadId: threadId,
      runId: runId,
      actionId: e.toolCallId
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: ActionExecutionEnd,
      actionExecutionEnd: legacyEvent
    ))
  
  of EventType.STATE_SNAPSHOT:
    let e = cast[StateSnapshotEvent](event)
    let legacyEvent = LegacyMetaEvent(
      threadId: threadId,
      runId: runId,
      name: "state_snapshot",
      payload: e.snapshot
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: MetaEvent,
      metaEvent: legacyEvent
    ))
  
  of EventType.STATE_DELTA:
    let e = cast[StateDeltaEvent](event)
    let legacyEvent = LegacyMetaEvent(
      threadId: threadId,
      runId: runId,
      name: "state_delta",
      payload: %*{"delta": e.delta}
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: MetaEvent,
      metaEvent: legacyEvent
    ))
  
  of EventType.RUN_STARTED:
    let e = cast[RunStartedEvent](event)
    let legacyEvent = LegacyMetaEvent(
      threadId: e.threadId,
      runId: e.runId,
      name: "run_started",
      payload: %*{}
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: MetaEvent,
      metaEvent: legacyEvent
    ))
  
  of EventType.RUN_FINISHED:
    let e = cast[RunFinishedEvent](event)
    let legacyEvent = LegacyMetaEvent(
      threadId: e.threadId,
      runId: e.runId,
      name: "run_finished",
      payload: %*{}
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: MetaEvent,
      metaEvent: legacyEvent
    ))
  
  of EventType.CUSTOM:
    let e = cast[CustomEvent](event)
    let legacyEvent = LegacyMetaEvent(
      threadId: threadId,
      runId: runId,
      name: e.name,
      payload: e.value
    )
    result = some(LegacyRuntimeProtocolEvent(
      eventType: MetaEvent,
      metaEvent: legacyEvent
    ))
  
  else:
    result = none(LegacyRuntimeProtocolEvent)

proc convertToStandardEvent*(event: LegacyRuntimeProtocolEvent): Option[BaseEvent] =
  ## Convert a legacy runtime protocol event to a standard AG-UI event
  case event.eventType
  of TextMessageStart:
    let e = event.textMessageStart
    let stdEvent = TextMessageStartEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      messageId: e.messageId,
      role: e.role
    )
    result = some(stdEvent)
  
  of TextMessageContent:
    let e = event.textMessageContent
    let stdEvent = TextMessageContentEvent(
      `type`: EventType.TEXT_MESSAGE_CONTENT,
      messageId: e.messageId,
      delta: e.content
    )
    result = some(stdEvent)
  
  of TextMessageEnd:
    let e = event.textMessageEnd
    let stdEvent = TextMessageEndEvent(
      `type`: EventType.TEXT_MESSAGE_END,
      messageId: e.messageId
    )
    result = some(stdEvent)
  
  of ActionExecutionStart:
    let e = event.actionExecutionStart
    let stdEvent = ToolCallStartEvent(
      `type`: EventType.TOOL_CALL_START,
      toolCallId: e.actionId,
      toolCallName: e.action
    )
    result = some(stdEvent)
  
  of ActionExecutionArgs:
    let e = event.actionExecutionArgs
    let stdEvent = ToolCallArgsEvent(
      `type`: EventType.TOOL_CALL_ARGS,
      toolCallId: e.actionId,
      delta: e.args
    )
    result = some(stdEvent)
  
  of ActionExecutionEnd:
    let e = event.actionExecutionEnd
    let stdEvent = ToolCallEndEvent(
      `type`: EventType.TOOL_CALL_END,
      toolCallId: e.actionId
    )
    result = some(stdEvent)
  
  of MetaEvent:
    let e = event.metaEvent
    case e.name
    of "state_snapshot":
      let stdEvent = StateSnapshotEvent(
        `type`: EventType.STATE_SNAPSHOT,
        snapshot: e.payload
      )
      result = some(stdEvent)
    
    of "state_delta":
      let delta = e.payload["delta"]
      let stdEvent = StateDeltaEvent(
        `type`: EventType.STATE_DELTA,
        delta: delta.getElems()
      )
      result = some(stdEvent)
    
    of "run_started":
      let stdEvent = RunStartedEvent(
        `type`: EventType.RUN_STARTED,
        threadId: e.threadId,
        runId: e.runId
      )
      result = some(stdEvent)
    
    of "run_finished":
      let stdEvent = RunFinishedEvent(
        `type`: EventType.RUN_FINISHED,
        threadId: e.threadId,
        runId: e.runId
      )
      result = some(stdEvent)
    
    else:
      let stdEvent = CustomEvent(
        `type`: EventType.CUSTOM,
        name: e.name,
        value: e.payload
      )
      result = some(stdEvent)

proc convertToLegacyEvents*(source: Observable[BaseEvent], threadId: string, runId: string): Observable[LegacyRuntimeProtocolEvent] =
  ## Convert a stream of standard AG-UI events to legacy runtime protocol events
  proc subscribe(observer: Observer[LegacyRuntimeProtocolEvent]): Subscription {.closure.} =
    proc onNext(event: BaseEvent) =
      let legacyEventOpt = convertToLegacyEvent(event, threadId, runId)
      if legacyEventOpt.isSome:
        observer.next(legacyEventOpt.get())
    
    let sourceObserver = Observer[BaseEvent](
      next: onNext,
      error: if observer.error.isSome: some(observer.error.get()) else: none(ErrorFunc),
      complete: if observer.complete.isSome: some(observer.complete.get()) else: none(CompleteFunc)
    )
    
    result = source.subscribe(sourceObserver)
  
  result = newObservable[LegacyRuntimeProtocolEvent](subscribe)

proc convertFromLegacyEvents*(source: Observable[LegacyRuntimeProtocolEvent]): Observable[BaseEvent] =
  ## Convert a stream of legacy runtime protocol events to standard AG-UI events
  proc subscribe(observer: Observer[BaseEvent]): Subscription {.closure.} =
    proc onNext(event: LegacyRuntimeProtocolEvent) =
      let stdEventOpt = convertToStandardEvent(event)
      if stdEventOpt.isSome:
        observer.next(stdEventOpt.get())
    
    let sourceObserver = Observer[LegacyRuntimeProtocolEvent](
      next: onNext,
      error: if observer.error.isSome: some(observer.error.get()) else: none(ErrorFunc),
      complete: if observer.complete.isSome: some(observer.complete.get()) else: none(CompleteFunc)
    )
    
    result = source.subscribe(sourceObserver)
  
  result = newObservable[BaseEvent](subscribe)