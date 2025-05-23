import ./types
import ./events
import json
import strutils
import options

type
  AgentState* = object
    messages*: seq[Message]
    state*: JsonNode

  PredictStateValue* = object
    stateKey*: string
    tool*: string
    toolArgument*: string

  ApplyEventsFunc* = proc(input: RunAgentInput, events: seq[BaseEvent]): seq[AgentState] {.gcsafe.}

proc structuredClone*[T](obj: T): T =
  ## Deep clones an object using JSON serialization
  when compiles(obj is JsonNode) and obj is JsonNode:
    result = parseJson($obj)
  else:
    var jsonStr = $(%*obj)
    var jsonObj = parseJson(jsonStr)
    result = to(jsonObj, T)

proc applyPatch*(state: JsonNode, patch: seq[JsonNode]): JsonNode =
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
  result = @[]
  if events.len == 0:
    return result
  
  # For each event, we'll create a new state (copy from previous or input)
  var currentState = AgentState(
    messages: input.messages,
    state: input.state
  )
  
  for event in events:
    # Create a copy of the current messages
    var messages = currentState.messages
    var state = currentState.state
    
    case event.type
    of EventType.TEXT_MESSAGE_START:
      let e = TextMessageStartEvent(event)
      # Create a new message
      var newMessage: Message
      case parseEnum[Role](e.role)
      of RoleAssistant:
        var assistant = AssistantMessage()
        assistant.id = e.messageId
        assistant.role = RoleAssistant
        assistant.content = some("")
        newMessage = Message(kind: MkAssistant, assistant: assistant)
      of RoleUser:
        var user = UserMessage()
        user.id = e.messageId
        user.role = RoleUser
        user.content = some("")
        newMessage = Message(kind: MkUser, user: user)
      of RoleSystem:
        var system = SystemMessage()
        system.id = e.messageId
        system.role = RoleSystem
        system.content = some("")
        newMessage = Message(kind: MkSystem, system: system)
      of RoleDeveloper:
        var developer = DeveloperMessage()
        developer.id = e.messageId
        developer.role = RoleDeveloper
        developer.content = some("")
        newMessage = Message(kind: MkDeveloper, developer: developer)
      of RoleTool:
        continue # Can't create a tool message without tool call ID
      
      messages.add(newMessage)
      
    of EventType.TEXT_MESSAGE_CONTENT:
      let e = TextMessageContentEvent(event)
      # Find the message and append content
      for i in 0..<messages.len:
        if messages[i].kind == MkAssistant and messages[i].assistant.id == e.messageId:
          if messages[i].assistant.content.isSome:
            messages[i].assistant.content = some(messages[i].assistant.content.get() & e.delta)
          else:
            messages[i].assistant.content = some(e.delta)
          break
        elif messages[i].kind == MkUser and messages[i].user.id == e.messageId:
          if messages[i].user.content.isSome:
            messages[i].user.content = some(messages[i].user.content.get() & e.delta)
          else:
            messages[i].user.content = some(e.delta)
          break
        elif messages[i].kind == MkSystem and messages[i].system.id == e.messageId:
          if messages[i].system.content.isSome:
            messages[i].system.content = some(messages[i].system.content.get() & e.delta)
          else:
            messages[i].system.content = some(e.delta)
          break
        elif messages[i].kind == MkDeveloper and messages[i].developer.id == e.messageId:
          if messages[i].developer.content.isSome:
            messages[i].developer.content = some(messages[i].developer.content.get() & e.delta)
          else:
            messages[i].developer.content = some(e.delta)
          break
      
    of EventType.TEXT_MESSAGE_END:
      # Message is already complete, no changes needed
      discard
      
    of EventType.TOOL_CALL_START:
      let e = ToolCallStartEvent(event)
      # Find or create assistant message
      var found = false
      for i in countdown(messages.len - 1, 0):
        if messages[i].kind == MkAssistant:
          var toolCall = ToolCall(
            id: e.toolCallId,
            `type`: "function",
            function: FunctionCall(
              name: e.toolCallName,
              arguments: ""
            )
          )
          if messages[i].assistant.toolCalls.isNone:
            messages[i].assistant.toolCalls = some(@[toolCall])
          else:
            var calls = messages[i].assistant.toolCalls.get()
            calls.add(toolCall)
            messages[i].assistant.toolCalls = some(calls)
          found = true
          break
      
      if not found:
        # Create new assistant message with tool call
        var assistant = AssistantMessage()
        assistant.id = "msg_" & $messages.len
        assistant.role = RoleAssistant
        assistant.content = none(string)
        assistant.toolCalls = some(@[ToolCall(
          id: e.toolCallId,
          `type`: "function",
          function: FunctionCall(
            name: e.toolCallName,
            arguments: ""
          )
        )])
        var newMessage = Message(kind: MkAssistant, assistant: assistant)
        messages.add(newMessage)
      
    of EventType.TOOL_CALL_ARGS:
      let e = ToolCallArgsEvent(event)
      # Find the tool call and append arguments
      for i in countdown(messages.len - 1, 0):
        if messages[i].kind == MkAssistant and messages[i].assistant.toolCalls.isSome:
          var toolCalls = messages[i].assistant.toolCalls.get()
          for j in 0..<toolCalls.len:
            if toolCalls[j].id == e.toolCallId:
              toolCalls[j].function.arguments &= e.delta
              messages[i].assistant.toolCalls = some(toolCalls)
              break
      
    of EventType.TOOL_CALL_END:
      # Tool call is complete, no changes needed
      discard
      
    of EventType.STATE_SNAPSHOT:
      let e = StateSnapshotEvent(event)
      state = e.snapshot
      
    of EventType.STATE_DELTA:
      let e = StateDeltaEvent(event)
      # Apply JSON patch
      state = applyPatch(state, e.delta)
      
    of EventType.MESSAGES_SNAPSHOT:
      let e = MessagesSnapshotEvent(event)
      messages = e.messages
      
    of EventType.CUSTOM, EventType.TEXT_MESSAGE_CHUNK, EventType.TOOL_CALL_CHUNK, 
       EventType.RAW, EventType.RUN_STARTED, EventType.RUN_FINISHED, 
       EventType.RUN_ERROR, EventType.STEP_STARTED, EventType.STEP_FINISHED:
      # For other events, no state changes needed
      discard
    
    # Update the current state for the next iteration
    currentState = AgentState(messages: messages, state: state)
    
    # Add the current state to the result
    result.add(currentState)