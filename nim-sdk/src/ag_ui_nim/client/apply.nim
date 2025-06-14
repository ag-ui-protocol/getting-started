import ../core/events
import ../core/types
import ../core/stream
import json
import strformat
import strutils

type
  PredictStateValue = object
    stateKey: string
    tool: string
    toolArgument: string

proc applyPatch(state: JsonNode, patch: seq[JsonNode]): JsonNode =
  ## Apply JSON patch operations to state
  result = state.copy()
  
  for operation in patch:
    let op = operation["op"].getStr()
    let path = operation["path"].getStr()
    
    case op
    of "add":
      let value = operation["value"]
      # Simple path implementation - just handles top-level keys for now
      let key = path.replace("/", "")
      result[key] = value
    of "remove":
      let key = path.replace("/", "")
      result.delete(key)
    of "replace":
      let value = operation["value"]
      let key = path.replace("/", "")
      result[key] = value
    else:
      discard

proc defaultApplyEvents*(input: RunAgentInput, events: seq[BaseEvent]): seq[AgentState] =
  ## Default implementation of ApplyEvents that transforms events into agent state
  var messages = input.messages
  var state = input.state
  var predictState: seq[PredictStateValue] = @[]
  
  result = @[]
  
  for event in events:
    case event.type
    of EventType.TEXT_MESSAGE_START:
      let e = cast[TextMessageStartEvent](event)
      # Create a new message
      var newMessage: Message
      case e.role
      of Role.assistant:
        newMessage = Message(
          id: e.messageId,
          role: e.role,
          content: some("")
        )
      of Role.user:
        newMessage = Message(
          id: e.messageId,
          role: e.role,
          content: some("")
        )
      else:
        newMessage = Message(
          id: e.messageId,
          role: e.role,
          content: some("")
        )
      
      messages.add(newMessage)
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.TEXT_MESSAGE_CONTENT:
      let e = cast[TextMessageContentEvent](event)
      # Find the message and append content
      for i in 0..<messages.len:
        if messages[i].id == e.messageId:
          if messages[i].content.isSome:
            messages[i].content = some(messages[i].content.get() & e.content)
          else:
            messages[i].content = some(e.content)
          break
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.TEXT_MESSAGE_END:
      # Message is already complete, just emit current state
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.TOOL_CALL_START:
      let e = cast[ToolCallStartEvent](event)
      # Find or create assistant message
      var found = false
      for i in countdown(messages.len - 1, 0):
        if messages[i].role == Role.assistant:
          var toolCall = ToolCall(
            id: e.toolCallId,
            `type`: "function",
            function: FunctionCall(
              name: e.toolCallName,
              arguments: ""
            )
          )
          if messages[i].toolCalls.isNone:
            messages[i].toolCalls = some(@[toolCall])
          else:
            var calls = messages[i].toolCalls.get()
            calls.add(toolCall)
            messages[i].toolCalls = some(calls)
          found = true
          break
      
      if not found:
        # Create new assistant message with tool call
        var newMessage = Message(
          id: fmt"msg_{messages.len}",
          role: Role.assistant,
          toolCalls: some(@[ToolCall(
            id: e.toolCallId,
            `type`: "function",
            function: FunctionCall(
              name: e.toolCallName,
              arguments: ""
            )
          )])
        )
        messages.add(newMessage)
      
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.TOOL_CALL_ARGS:
      let e = cast[ToolCallArgsEvent](event)
      # Find the tool call and append arguments
      for i in countdown(messages.len - 1, 0):
        if messages[i].role == Role.assistant and messages[i].toolCalls.isSome:
          var toolCalls = messages[i].toolCalls.get()
          for j in 0..<toolCalls.len:
            if toolCalls[j].id == e.toolCallId:
              toolCalls[j].function.arguments &= e.args
              messages[i].toolCalls = some(toolCalls)
              break
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.TOOL_CALL_END:
      # Tool call is complete, just emit current state
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.STATE_SNAPSHOT:
      let e = cast[StateSnapshotEvent](event)
      state = e.state
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.STATE_DELTA:
      let e = cast[StateDeltaEvent](event)
      # Apply JSON patch
      state = applyPatch(state, e.delta)
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.MESSAGES_SNAPSHOT:
      let e = cast[MessagesSnapshotEvent](event)
      messages = e.messages
      result.add(AgentState(messages: messages, state: state))
      
    of EventType.CUSTOM:
      let e = cast[CustomEvent](event)
      if e.eventName == "__copilotkit:optimisticStateUpdate":
        # Handle optimistic state updates
        try:
          let payload = parseJson(e.payload)
          if payload.hasKey("tool"):
            var predictValue = PredictStateValue(
              stateKey: payload["state_key"].getStr(),
              tool: payload["tool"].getStr(),
              toolArgument: payload["tool_argument"].getStr()
            )
            predictState.add(predictValue)
        except:
          discard
      
      result.add(AgentState(messages: messages, state: state))
      
    else:
      # For other events, just emit current state
      result.add(AgentState(messages: messages, state: state))