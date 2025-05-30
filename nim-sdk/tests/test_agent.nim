import unittest, json, options, asyncdispatch, times, strutils
import ../src/ag_ui_nim/client/agent
import ../src/ag_ui_nim/core/[types, events]

# Mock agent for testing
type
  MockAgent* = ref object of AbstractAgent
    runCallCount*: int
    lastInput*: RunAgentInput
    returnEvents*: seq[Event]
    shouldError*: bool
    errorMessage*: string

proc newMockAgent*(events: seq[Event] = @[], shouldError: bool = false): MockAgent =
  result = MockAgent()
  result.returnEvents = events
  result.shouldError = shouldError
  result.runCallCount = 0
  result.errorMessage = "Mock error"
  result.agentId = "mock-agent"
  result.description = "Test mock agent"

method run*(self: MockAgent, input: RunAgentInput): Future[EventStream] {.async.} =
  self.runCallCount += 1
  self.lastInput = input
  
  if self.shouldError:
    raise newException(Exception, self.errorMessage)
  
  return iterator: Event {.closure.} =
    for event in self.returnEvents:
      yield event

method abortRun*(self: MockAgent) =
  discard

suite "Agent Module Tests":
  test "AbstractAgent creation":
    let agent = newAbstractAgent(
      agentId = "test-agent",
      description = "Test agent",
      threadId = some("thread-123")
    )
    
    check agent.agentId == "test-agent"
    check agent.description == "Test agent"
    check agent.threadId.get() == "thread-123"
    check agent.messages.len == 0
    check agent.state == newJNull()
  
  test "AbstractAgent with initial state and messages":
    let msg = Message(kind: MkUser, user: newUserMessage("u1", "Hello"))
    let initialState = %*{"counter": 42}
    
    let agent = newAbstractAgent(
      initialMessages = @[msg],
      initialState = initialState
    )
    
    check agent.messages.len == 1
    check agent.messages[0].kind == MkUser
    check agent.state["counter"].getInt() == 42
  
  test "prepareRunAgentInput basic":
    let agent = newAbstractAgent()
    let params = %*{}
    
    let input = agent.prepareRunAgentInput(params)
    
    check input.threadId.len > 0
    check input.runId.len > 0
    check input.state == newJNull()
    check input.messages.len == 0
    check input.tools.len == 0
    check input.context.len == 0
  
  test "prepareRunAgentInput with tools and context":
    let agent = newAbstractAgent()
    let params = %*{
      "tools": [
        {"name": "search", "description": "Search tool", "parameters": {}}
      ],
      "context": [
        {"description": "user_id", "value": "12345"}
      ]
    }
    
    let input = agent.prepareRunAgentInput(params)
    
    check input.tools.len == 1
    check input.tools[0].name == "search"
    check input.context.len == 1
    check input.context[0].description == "user_id"
  
  test "prepareRunAgentInput uses agent state and messages":
    let msg = Message(kind: MkUser, user: newUserMessage("u1", "Test"))
    let agent = newAbstractAgent(
      threadId = some("existing-thread"),
      initialMessages = @[msg],
      initialState = %*{"foo": "bar"}
    )
    
    let input = agent.prepareRunAgentInput(%*{})
    
    check input.threadId == "existing-thread"
    check input.messages.len == 1
    check input.state["foo"].getStr() == "bar"
  
  test "Event verification - valid events":
    let validEvent = Event(
      kind: EkTextMessageContent,
      textMessageContent: newTextMessageContentEvent("m1", "Hello")
    )
    
    check verifyEvent(validEvent) == true
  
  test "Event verification - invalid TextMessageContent":
    var invalidEvent = Event(kind: EkTextMessageContent)
    invalidEvent.textMessageContent = TextMessageContentEvent()
    invalidEvent.textMessageContent.delta = ""  # Empty delta is invalid
    
    check verifyEvent(invalidEvent) == false
  
  test "defaultApplyEvents success":
    let agent = newAbstractAgent()
    let events = @[
      Event(kind: EkTextMessageStart, 
            textMessageStart: newTextMessageStartEvent("m1", "assistant")),
      Event(kind: EkTextMessageContent,
            textMessageContent: newTextMessageContentEvent("m1", "Hello"))
    ]
    
    let pipeline = agent.defaultApplyEvents(events)
    
    check pipeline.error.isNone
    check pipeline.events.len == 2
  
  test "defaultApplyEvents with invalid event":
    let agent = newAbstractAgent()
    var invalidEvent = Event(kind: EkTextMessageContent)
    invalidEvent.textMessageContent = TextMessageContentEvent()
    invalidEvent.textMessageContent.delta = ""
    
    let events = @[invalidEvent]
    let pipeline = agent.defaultApplyEvents(events)
    
    check pipeline.error.isSome
    check pipeline.error.get().contains("Invalid event")
  
  test "processApplyEvents - state snapshot":
    let agent = newAbstractAgent()
    let newState = %*{"updated": true, "value": 123}
    let event = Event(
      kind: EkStateSnapshot,
      stateSnapshot: newStateSnapshotEvent(newState)
    )
    
    agent.processApplyEvents(@[event])
    
    check agent.state["updated"].getBool() == true
    check agent.state["value"].getInt() == 123
  
  test "processApplyEvents - messages snapshot":
    let agent = newAbstractAgent()
    let msg1 = Message(kind: MkUser, user: newUserMessage("u1", "Hi"))
    let msg2 = Message(kind: MkAssistant, assistant: newAssistantMessage("a1", some("Hello")))
    let event = Event(
      kind: EkMessagesSnapshot,
      messagesSnapshot: newMessagesSnapshotEvent(@[msg1, msg2])
    )
    
    agent.processApplyEvents(@[event])
    
    check agent.messages.len == 2
    check agent.messages[0].kind == MkUser
    check agent.messages[1].kind == MkAssistant
  
  test "runAgent success flow":
    # Create mock with predefined events
    let events = @[
      Event(kind: EkTextMessageStart,
            textMessageStart: newTextMessageStartEvent("m1", "assistant")),
      Event(kind: EkTextMessageContent,
            textMessageContent: newTextMessageContentEvent("m1", "Test response"))
    ]
    
    let agent = newMockAgent(events)
    let pipeline = waitFor agent.runAgent(%*{})
    
    check agent.runCallCount == 1
    check pipeline.error.isNone
    # Should have original events + run started/finished
    check pipeline.events.len >= 3
    
    # Check run lifecycle events
    check pipeline.events[0].kind == EkRunStarted
    check pipeline.events[^1].kind == EkRunFinished
  
  test "runAgent error handling":
    let agent = newMockAgent(shouldError = true)
    agent.errorMessage = "Network error"
    
    let pipeline = waitFor agent.runAgent(%*{})
    
    check agent.runCallCount == 1
    check pipeline.error.isSome
    check pipeline.error.get().contains("Network error")
    
    # Should have run started and error events
    var hasRunError = false
    for event in pipeline.events:
      if event.kind == EkRunError:
        hasRunError = true
        check event.runError.message.contains("Network error")
    
    check hasRunError
  
  test "runAgent updates thread ID":
    let agent = newMockAgent()
    check agent.threadId.isNone
    
    let pipeline = waitFor agent.runAgent(%*{})
    
    check agent.threadId.isSome
    check agent.threadId.get().len > 0
    
    # Thread ID should be preserved in subsequent runs
    let oldThreadId = agent.threadId.get()
    let pipeline2 = waitFor agent.runAgent(%*{})
    check agent.threadId.get() == oldThreadId
  
  test "runAgent state updates":
    let stateEvent = Event(
      kind: EkStateSnapshot,
      stateSnapshot: newStateSnapshotEvent(%*{"counter": 100})
    )
    
    let agent = newMockAgent(@[stateEvent])
    let pipeline = waitFor agent.runAgent(%*{})
    
    check pipeline.error.isNone
    check agent.state["counter"].getInt() == 100
  
  test "Agent clone":
    let msg = Message(kind: MkUser, user: newUserMessage("u1", "Test"))
    let agent = newAbstractAgent(
      agentId = "original",
      description = "Original agent",
      threadId = some("thread-123"),
      initialMessages = @[msg],
      initialState = %*{"value": 42}
    )
    
    let cloned = agent.clone()
    
    check cloned.agentId == agent.agentId
    check cloned.description == agent.description
    check cloned.threadId == agent.threadId
    check cloned.messages.len == agent.messages.len
    check cloned.state["value"].getInt() == 42
    
    # Ensure deep copy
    agent.state["value"] = %*99
    check cloned.state["value"].getInt() == 42  # Should not change