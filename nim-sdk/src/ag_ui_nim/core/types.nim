import std/[options, json, tables]

type
  FunctionCall* = object
    name*: string
    arguments*: string

  ToolCall* = object
    id*: string
    `type`*: string
    function*: FunctionCall

  Role* = enum
    RoleDeveloper = "developer"
    RoleSystem = "system"
    RoleAssistant = "assistant"
    RoleUser = "user"
    RoleTool = "tool"

  BaseMessage* = object of RootObj
    id*: string
    role*: Role
    content*: Option[string]
    name*: Option[string]

  DeveloperMessage* = object of BaseMessage

  SystemMessage* = object of BaseMessage

  AssistantMessage* = object of BaseMessage
    toolCalls*: Option[seq[ToolCall]]

  UserMessage* = object of BaseMessage

  ToolMessage* = object
    id*: string
    role*: Role
    content*: string
    toolCallId*: string

  MessageKind* = enum
    MkDeveloper
    MkSystem
    MkAssistant
    MkUser
    MkTool

  Message* = object
    case kind*: MessageKind
    of MkDeveloper:
      developer*: DeveloperMessage
    of MkSystem:
      system*: SystemMessage
    of MkAssistant:
      assistant*: AssistantMessage
    of MkUser:
      user*: UserMessage
    of MkTool:
      tool*: ToolMessage

  Context* = object
    description*: string
    value*: string

  Tool* = object
    name*: string
    description*: string
    parameters*: JsonNode

  RunAgentInput* = object
    threadId*: string
    runId*: string
    state*: JsonNode
    messages*: seq[Message]
    tools*: seq[Tool]
    context*: seq[Context]
    forwardedProps*: JsonNode

  State* = JsonNode

  AGUIError* = object of CatchableError

# Constructor procs
proc newFunctionCall*(name: string, arguments: string): FunctionCall =
  FunctionCall(name: name, arguments: arguments)

proc newToolCall*(id: string, `type`: string = "function", function: FunctionCall): ToolCall =
  ToolCall(id: id, `type`: `type`, function: function)

proc newDeveloperMessage*(id: string, content: string, name: Option[string] = none(string)): DeveloperMessage =
  result = DeveloperMessage()
  result.id = id
  result.role = RoleDeveloper
  result.content = some(content)
  result.name = name

proc newSystemMessage*(id: string, content: string, name: Option[string] = none(string)): SystemMessage =
  result = SystemMessage()
  result.id = id
  result.role = RoleSystem
  result.content = some(content)
  result.name = name

proc newAssistantMessage*(id: string, content: Option[string] = none(string), 
                          toolCalls: Option[seq[ToolCall]] = none(seq[ToolCall]), 
                          name: Option[string] = none(string)): AssistantMessage =
  result = AssistantMessage()
  result.id = id
  result.role = RoleAssistant
  result.content = content
  result.toolCalls = toolCalls
  result.name = name

proc newUserMessage*(id: string, content: string, name: Option[string] = none(string)): UserMessage =
  result = UserMessage()
  result.id = id
  result.role = RoleUser
  result.content = some(content)
  result.name = name

proc newToolMessage*(id: string, content: string, toolCallId: string): ToolMessage =
  ToolMessage(id: id, role: RoleTool, content: content, toolCallId: toolCallId)

proc newContext*(description: string, value: string): Context =
  Context(description: description, value: value)

proc newTool*(name: string, description: string, parameters: JsonNode): Tool =
  Tool(name: name, description: description, parameters: parameters)

proc newRunAgentInput*(threadId: string, runId: string, state: JsonNode,
                       messages: seq[Message], tools: seq[Tool], 
                       context: seq[Context], forwardedProps: JsonNode): RunAgentInput =
  RunAgentInput(
    threadId: threadId,
    runId: runId,
    state: state,
    messages: messages,
    tools: tools,
    context: context,
    forwardedProps: forwardedProps
  )

# Conversion to JSON
proc toJson*(fc: FunctionCall): JsonNode =
  %*{
    "name": fc.name,
    "arguments": fc.arguments
  }

proc toJson*(tc: ToolCall): JsonNode =
  %*{
    "id": tc.id,
    "type": tc.`type`,
    "function": tc.function.toJson()
  }

proc toJson*(msg: BaseMessage): JsonNode =
  result = %*{
    "id": msg.id,
    "role": $msg.role
  }
  if msg.content.isSome:
    result["content"] = %msg.content.get
  if msg.name.isSome:
    result["name"] = %msg.name.get

proc toJson*(msg: DeveloperMessage): JsonNode =
  result = %*{
    "id": msg.id,
    "role": $msg.role
  }
  if msg.content.isSome:
    result["content"] = %msg.content.get
  if msg.name.isSome:
    result["name"] = %msg.name.get

proc toJson*(msg: SystemMessage): JsonNode =
  result = %*{
    "id": msg.id,
    "role": $msg.role
  }
  if msg.content.isSome:
    result["content"] = %msg.content.get
  if msg.name.isSome:
    result["name"] = %msg.name.get

proc toJson*(msg: AssistantMessage): JsonNode =
  result = %*{
    "id": msg.id,
    "role": $msg.role
  }
  if msg.content.isSome:
    result["content"] = %msg.content.get
  if msg.name.isSome:
    result["name"] = %msg.name.get
  if msg.toolCalls.isSome:
    let toolCallsJson = newJArray()
    for tc in msg.toolCalls.get:
      toolCallsJson.add(tc.toJson())
    result["toolCalls"] = toolCallsJson

proc toJson*(msg: UserMessage): JsonNode =
  result = %*{
    "id": msg.id,
    "role": $msg.role
  }
  if msg.content.isSome:
    result["content"] = %msg.content.get
  if msg.name.isSome:
    result["name"] = %msg.name.get

proc toJson*(msg: ToolMessage): JsonNode =
  %*{
    "id": msg.id,
    "role": $msg.role,
    "content": msg.content,
    "toolCallId": msg.toolCallId
  }

proc toJson*(msg: Message): JsonNode =
  case msg.kind
  of MkDeveloper:
    msg.developer.toJson()
  of MkSystem:
    msg.system.toJson()
  of MkAssistant:
    msg.assistant.toJson()
  of MkUser:
    msg.user.toJson()
  of MkTool:
    msg.tool.toJson()

proc toJson*(ctx: Context): JsonNode =
  %*{
    "description": ctx.description,
    "value": ctx.value
  }

proc toJson*(tool: Tool): JsonNode =
  %*{
    "name": tool.name,
    "description": tool.description,
    "parameters": tool.parameters
  }

proc toJson*(input: RunAgentInput): JsonNode =
  result = %*{
    "threadId": input.threadId,
    "runId": input.runId,
    "state": input.state,
    "forwardedProps": input.forwardedProps
  }
  let messagesJson = newJArray()
  for msg in input.messages:
    messagesJson.add(msg.toJson())
  result["messages"] = messagesJson
  
  let toolsJson = newJArray()
  for tool in input.tools:
    toolsJson.add(tool.toJson())
  result["tools"] = toolsJson
  
  let contextJson = newJArray()
  for ctx in input.context:
    contextJson.add(ctx.toJson())
  result["context"] = contextJson

# From JSON conversion
proc fromJson*(json: JsonNode, T: typedesc[FunctionCall]): FunctionCall =
  FunctionCall(
    name: json["name"].getStr,
    arguments: json["arguments"].getStr
  )

proc fromJson*(json: JsonNode, T: typedesc[ToolCall]): ToolCall =
  ToolCall(
    id: json["id"].getStr,
    `type`: json["type"].getStr,
    function: fromJson(json["function"], FunctionCall)
  )

proc fromJson*(json: JsonNode, T: typedesc[Context]): Context =
  Context(
    description: json["description"].getStr,
    value: json["value"].getStr
  )

proc fromJson*(json: JsonNode, T: typedesc[Tool]): Tool =
  Tool(
    name: json["name"].getStr,
    description: json["description"].getStr,
    parameters: json["parameters"]
  )

proc fromJson*(json: JsonNode, T: typedesc[DeveloperMessage]): DeveloperMessage =
  result = DeveloperMessage()
  result.id = json["id"].getStr
  result.role = RoleDeveloper
  if json.hasKey("content"):
    result.content = some(json["content"].getStr)
  if json.hasKey("name"):
    result.name = some(json["name"].getStr)

proc fromJson*(json: JsonNode, T: typedesc[SystemMessage]): SystemMessage =
  result = SystemMessage()
  result.id = json["id"].getStr
  result.role = RoleSystem
  if json.hasKey("content"):
    result.content = some(json["content"].getStr)
  if json.hasKey("name"):
    result.name = some(json["name"].getStr)

proc fromJson*(json: JsonNode, T: typedesc[AssistantMessage]): AssistantMessage =
  result = AssistantMessage()
  result.id = json["id"].getStr
  result.role = RoleAssistant
  if json.hasKey("content"):
    result.content = some(json["content"].getStr)
  if json.hasKey("name"):
    result.name = some(json["name"].getStr)
  if json.hasKey("toolCalls"):
    var toolCalls: seq[ToolCall] = @[]
    for tc in json["toolCalls"]:
      toolCalls.add(fromJson(tc, ToolCall))
    result.toolCalls = some(toolCalls)

proc fromJson*(json: JsonNode, T: typedesc[UserMessage]): UserMessage =
  result = UserMessage()
  result.id = json["id"].getStr
  result.role = RoleUser
  if json.hasKey("content"):
    result.content = some(json["content"].getStr)
  if json.hasKey("name"):
    result.name = some(json["name"].getStr)

proc fromJson*(json: JsonNode, T: typedesc[ToolMessage]): ToolMessage =
  ToolMessage(
    id: json["id"].getStr,
    role: RoleTool,
    content: json["content"].getStr,
    toolCallId: json["toolCallId"].getStr
  )

# Export commonly used procs
export toJson, fromJson, newFunctionCall, newToolCall, newDeveloperMessage, newSystemMessage,
       newAssistantMessage, newUserMessage, newToolMessage, newContext, newTool, newRunAgentInput