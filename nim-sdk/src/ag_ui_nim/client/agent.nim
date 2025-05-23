import std/[options, asyncdispatch, tables, json, strutils, sequtils, times]
import ../core/[types, events]

type
  NotImplementedError* = object of CatchableError
  
  EventStream* = iterator: Event {.closure.}
  
  AbstractAgent* = ref object of RootObj
    agentId*: string
    description*: string
    threadId*: Option[string]
    messages*: seq[Message]
    state*: State

  EventPipeline* = object
    events*: seq[Event]
    error*: Option[string]

proc newAbstractAgent*(
  agentId: string = "",
  description: string = "",
  threadId: Option[string] = none(string),
  initialMessages: seq[Message] = @[],
  initialState: State = newJNull()
): AbstractAgent =
  result = AbstractAgent()
  result.agentId = agentId
  result.description = description
  result.threadId = threadId
  result.messages = initialMessages
  result.state = initialState

method run*(self: AbstractAgent, input: RunAgentInput): Future[EventStream] {.base, async.} =
  raise newException(NotImplementedError, "Subclasses must implement the run method")

method abortRun*(self: AbstractAgent) {.base.} =
  raise newException(NotImplementedError, "Subclasses must implement the abortRun method")

proc generateId(): string =
  # Simple ID generation (in production, use UUID)
  result = "id_" & $epochTime().int64

proc generateThreadId(): string =
  "thread_" & generateId()

proc generateRunId(): string =
  "run_" & generateId()

proc prepareRunAgentInput*(self: AbstractAgent, parameters: JsonNode): RunAgentInput =
  let threadId = if self.threadId.isSome: 
    self.threadId.get 
  else: 
    generateThreadId()
  
  let runId = generateRunId()
  
  result = RunAgentInput(
    threadId: threadId,
    runId: runId,
    state: self.state,
    messages: self.messages,
    tools: @[],
    context: @[],
    forwardedProps: parameters
  )

  # Extract tools if provided
  if parameters.hasKey("tools"):
    for tool in parameters["tools"]:
      result.tools.add(fromJson(tool, Tool))
  
  # Extract context if provided
  if parameters.hasKey("context"):
    for ctx in parameters["context"]:
      result.context.add(fromJson(ctx, Context))

proc verifyEvent*(event: Event): bool =
  # Basic event verification
  case event.kind
  of EkTextMessageContent:
    return event.textMessageContent.delta.len > 0
  else:
    return true

proc defaultApplyEvents*(self: AbstractAgent, events: seq[Event]): EventPipeline =
  result.events = @[]
  result.error = none(string)
  
  for event in events:
    if not verifyEvent(event):
      result.error = some("Invalid event: " & $event.kind)
      break
    result.events.add(event)

method apply*(self: AbstractAgent, events: seq[Event]): EventPipeline {.base.} =
  defaultApplyEvents(self, events)

proc processApplyEvents*(self: AbstractAgent, events: seq[Event]) =
  for event in events:
    case event.kind
    of EkStateSnapshot:
      self.state = event.stateSnapshot.snapshot.copy()
    of EkStateDelta:
      # Apply JSON Patch (simplified for now)
      discard
    of EkMessagesSnapshot:
      self.messages = event.messagesSnapshot.messages
    else:
      discard

proc runAgent*(self: AbstractAgent, parameters: JsonNode = %*{}): Future[EventPipeline] {.async.} =
  let input = self.prepareRunAgentInput(parameters)
  
  # Update thread ID if not set
  if self.threadId.isNone:
    self.threadId = some(input.threadId)
  
  var pipeline = EventPipeline()
  pipeline.events = @[]
  
  try:
    # Emit run started event
    var runStartedEvent = Event(kind: EkRunStarted)
    runStartedEvent.runStarted = newRunStartedEvent(input.threadId, input.runId)
    pipeline.events.add(runStartedEvent)
    
    # Run the agent
    let eventStream = await self.run(input)
    
    # Process events from the stream
    var currentEvents: seq[Event] = @[]
    for event in eventStream():
      currentEvents.add(event)
    
    # Apply and verify events
    let applyResult = self.apply(currentEvents)
    if applyResult.error.isSome:
      pipeline.error = applyResult.error
      # Emit error event
      var errorEvent = Event(kind: EkRunError)
      errorEvent.runError = newRunErrorEvent(applyResult.error.get)
      pipeline.events.add(errorEvent)
    else:
      pipeline.events.add(applyResult.events)
      self.processApplyEvents(applyResult.events)
    
    # Emit run finished event
    var runFinishedEvent = Event(kind: EkRunFinished)
    runFinishedEvent.runFinished = newRunFinishedEvent(input.threadId, input.runId)
    pipeline.events.add(runFinishedEvent)
    
  except Exception as e:
    pipeline.error = some(e.msg)
    # Emit error event
    var errorEvent = Event(kind: EkRunError)
    errorEvent.runError = newRunErrorEvent(e.msg)
    pipeline.events.add(errorEvent)
  
  return pipeline

proc clone*(self: AbstractAgent): AbstractAgent =
  result = newAbstractAgent(
    agentId = self.agentId,
    description = self.description,
    threadId = self.threadId,
    initialMessages = self.messages,
    initialState = self.state.copy()
  )

export AbstractAgent, EventStream, EventPipeline, newAbstractAgent, runAgent, clone