import ./types
import ./events
import json
import strformat
import options
import strutils
import tables

type
  ValidationErrorKind* = enum
    Missing = "missing_field"      # Required field is missing
    TypeMismatch = "type_mismatch" # Field has wrong type
    InvalidValue = "invalid_value" # Value doesn't match constraints
    Custom = "custom_error"       # Other validation error
  
  ValidationError* = object of CatchableError
    path*: string        # JSON path to the field with error
    message*: string     # Human-readable error message
    kind*: ValidationErrorKind # Type of validation error
    expectedType*: string # Expected type for TypeMismatch errors
    gotType*: string     # Actual type for TypeMismatch errors

proc newValidationError*(path, message: string, kind: ValidationErrorKind = Custom,
                          expectedType: string = "", gotType: string = ""): ref ValidationError =
  ## Creates a new ValidationError with detailed information
  var err = new ValidationError
  err.path = path
  err.message = message
  err.kind = kind
  err.expectedType = expectedType
  err.gotType = gotType
  return err

# Forward declaration of some validation functions
proc validateMessage*(node: JsonNode, path: string): Message

# Forward declarations for complex types that will be validated
proc validateJsonSchema*(node: JsonNode, path: string): JsonNode
proc validateJsonPatch*(node: JsonNode, path: string): JsonNode
proc validateFunctionCallParameters*(node: JsonNode, path: string): JsonNode

proc validateString*(node: JsonNode, path: string): string =
  ## Validate that a JSON node is a string
  if node == nil:
    raise newValidationError(path, fmt"{path} is required but missing", Missing)
  if node.kind != JString:
    raise newValidationError(path, fmt"{path} must be a string", 
                            TypeMismatch, "string", $node.kind)
  result = node.getStr()

proc validateEnum*[T: enum](node: JsonNode, path: string): T =
  ## Validate that a JSON node is a valid enum value
  if node == nil:
    raise newValidationError(path, fmt"{path} is required but missing", Missing)
  if node.kind != JString:
    raise newValidationError(path, fmt"{path} must be a string", 
                            TypeMismatch, "string", $node.kind)
  
  let strValue = node.getStr()
  try:
    result = parseEnum[T](strValue)
  except ValueError:
    var validValues = ""
    for e in T:
      if validValues.len > 0: validValues.add(", ")
      validValues.add($e)
    
    raise newValidationError(path, 
                            fmt"{path} has invalid value: '{strValue}'. Valid values are: {validValues}", 
                            InvalidValue)

proc validateObject*(node: JsonNode, path: string): JsonNode =
  ## Validate that a JSON node is an object
  if node == nil:
    raise newValidationError(path, fmt"{path} is required but missing", Missing)
  if node.kind != JObject:
    raise newValidationError(path, fmt"{path} must be an object", 
                            TypeMismatch, "object", $node.kind)
  result = node

proc validateObjectKeys*(node: JsonNode, path: string, requiredKeys: openArray[string]): JsonNode =
  ## Validate that a JSON node is an object and contains all required keys
  let obj = validateObject(node, path)
  
  for key in requiredKeys:
    if not obj.hasKey(key):
      raise newValidationError(fmt"{path}.{key}", 
                              fmt"Required field '{key}' is missing in {path}",
                              Missing)
  
  result = obj

proc validateArray*(node: JsonNode, path: string): JsonNode =
  ## Validate that a JSON node is an array
  if node == nil:
    raise newValidationError(path, fmt"{path} is required but missing", Missing)
  if node.kind != JArray:
    raise newValidationError(path, fmt"{path} must be an array", 
                            TypeMismatch, "array", $node.kind)
  result = node

proc validateArrayMinLength*(node: JsonNode, path: string, minLength: int): JsonNode =
  ## Validate that a JSON array has at least minLength elements
  let arr = validateArray(node, path)
  
  if arr.len < minLength:
    raise newValidationError(path, 
                            fmt"{path} must have at least {minLength} elements, but has {arr.len}",
                            InvalidValue)
  
  result = arr

proc validateOptionalString*(node: JsonNode, path: string): Option[string] =
  ## Validate that a JSON node is an optional string
  if node == nil or node.kind == JNull:
    result = none(string)
  else:
    if node.kind != JString:
      raise newValidationError(path, fmt"{path} must be a string or null", 
                              TypeMismatch, "string or null", $node.kind)
    result = some(node.getStr())

proc validateOptionalInt*(node: JsonNode, path: string): Option[int] =
  ## Validate that a JSON node is an optional int
  if node == nil or node.kind == JNull:
    result = none(int)
  elif node.kind == JInt:
    result = some(node.getInt)
  else:
    raise newValidationError(path, fmt"{path} must be an integer or null", 
                            TypeMismatch, "integer or null", $node.kind)

proc validateOptionalInt64*(node: JsonNode, path: string): Option[int64] =
  ## Validate that a JSON node is an optional int64
  if node == nil or node.kind == JNull:
    result = none(int64)
  elif node.kind == JInt:
    result = some(node.getBiggestInt)
  else:
    raise newValidationError(path, fmt"{path} must be an integer or null", 
                            TypeMismatch, "integer or null", $node.kind)

proc validateOptionalBool*(node: JsonNode, path: string): Option[bool] =
  ## Validate that a JSON node is an optional boolean
  if node == nil or node.kind == JNull:
    result = none(bool)
  elif node.kind == JBool:
    result = some(node.getBool)
  else:
    raise newValidationError(path, fmt"{path} must be a boolean or null", 
                            TypeMismatch, "boolean or null", $node.kind)

proc validateJsonSchema*(node: JsonNode, path: string): JsonNode =
  ## Validate that a JSON node conforms to a simplified JSON Schema structure
  let obj = validateObject(node, path)
  if obj.hasKey("type"):
    let typeNode = obj["type"]
    if typeNode.kind != JString and typeNode.kind != JArray:
      raise newValidationError(fmt"{path}.type", 
                              fmt"{path}.type must be a string or array of strings",
                              TypeMismatch, "string or array", $typeNode.kind)
  
  if obj.hasKey("properties") and obj["properties"].kind != JNull:
    let props = validateObject(obj["properties"], fmt"{path}.properties")
    for key, val in props:
      if val.kind != JObject:
        raise newValidationError(fmt"{path}.properties.{key}", 
                                fmt"{path}.properties.{key} must be an object",
                                TypeMismatch, "object", $val.kind)
      discard validateJsonSchema(val, fmt"{path}.properties.{key}")
  
  if obj.hasKey("required") and obj["required"].kind != JNull:
    let req = validateArray(obj["required"], fmt"{path}.required")
    for i in 0..<req.len:
      if req[i].kind != JString:
        raise newValidationError(fmt"{path}.required[{i}]", 
                                fmt"{path}.required[{i}] must be a string",
                                TypeMismatch, "string", $req[i].kind)
  result = obj

proc validateJsonPatchOperation*(op: JsonNode, path: string, index: int): JsonNode =
  let opPath = fmt"{path}[{index}]"
  let obj = validateObject(op, opPath)
  if not obj.hasKey("op"): raise newValidationError(fmt"{opPath}.op", "Required field 'op' missing", Missing)
  if obj["op"].kind != JString: raise newValidationError(fmt"{opPath}.op", "op must be string", TypeMismatch, "string", $obj["op"].kind)
  let operation = obj["op"].getStr()
  let validOps = ["add", "remove", "replace", "move", "copy", "test"]
  if operation notin validOps: raise newValidationError(fmt"{opPath}.op", "Invalid op value", InvalidValue)
  if not obj.hasKey("path"): raise newValidationError(fmt"{opPath}.path", "Required field 'path' missing", Missing)
  result = obj

proc validateJsonPatch*(node: JsonNode, path: string): JsonNode =
  let arr = validateArray(node, path)
  for i in 0..<arr.len: discard validateJsonPatchOperation(arr[i], path, i)
  result = arr

proc validateFunctionCallParameters*(node: JsonNode, path: string): JsonNode =
  result = validateObject(node, path)

proc validateFunctionCall*(node: JsonNode, path: string): FunctionCall =
  let obj = validateObjectKeys(node, path, ["name", "arguments"])
  result.name = validateString(obj["name"], fmt"{path}.name")
  let args = validateString(obj["arguments"], fmt"{path}.arguments")
  try:
    discard parseJson(args)
  except:
    raise newValidationError(fmt"{path}.arguments", "Must be a valid JSON string", InvalidValue)
  result.arguments = args

proc validateToolCall*(node: JsonNode, path: string): ToolCall =
  let obj = validateObjectKeys(node, path, ["id", "type", "function"])
  result.id = validateString(obj["id"], fmt"{path}.id")
  result.`type` = validateString(obj["type"], fmt"{path}.type")
  result.function = validateFunctionCall(obj["function"], fmt"{path}.function")

proc validateBaseMessage*(node: JsonNode, path: string): BaseMessage =
  let obj = validateObject(node, path)
  result.id = validateString(obj["id"], fmt"{path}.id")
  result.role = validateEnum[Role](obj["role"], fmt"{path}.role")
  result.content = validateOptionalString(obj.getOrDefault("content"), fmt"{path}.content")
  result.name = validateOptionalString(obj.getOrDefault("name"), fmt"{path}.name")

proc validateDeveloperMessage*(node: JsonNode, path: string): DeveloperMessage =
  result = DeveloperMessage(validateBaseMessage(node, path))

proc validateSystemMessage*(node: JsonNode, path: string): SystemMessage =
  result = SystemMessage(validateBaseMessage(node, path))

proc validateAssistantMessage*(node: JsonNode, path: string): AssistantMessage =
  result = AssistantMessage(validateBaseMessage(node, path))
  if node.hasKey("toolCalls") and node["toolCalls"].kind != JNull:
    let toolCallsArray = validateArray(node["toolCalls"], fmt"{path}.toolCalls")
    var toolCalls: seq[ToolCall] = @[]
    for i, toolCallNode in toolCallsArray:
      toolCalls.add(validateToolCall(toolCallNode, fmt"{path}.toolCalls[{i}]"))
    result.toolCalls = some(toolCalls)
  else:
    result.toolCalls = none(seq[ToolCall])

proc validateUserMessage*(node: JsonNode, path: string): UserMessage =
  result = UserMessage(validateBaseMessage(node, path))

proc validateToolMessage*(node: JsonNode, path: string): ToolMessage =
  let obj = validateObject(node, path)
  result.id = validateString(obj["id"], fmt"{path}.id")
  result.role = validateEnum[Role](obj["role"], fmt"{path}.role")
  result.content = validateString(obj["content"], fmt"{path}.content")
  result.toolCallId = validateString(obj["toolCallId"], fmt"{path}.toolCallId")

proc validateMessage*(node: JsonNode, path: string): Message =
  let obj = validateObject(node, path)
  let role = validateEnum[Role](obj["role"], fmt"{path}.role")
  case role
  of RoleDeveloper: result = Message(kind: MkDeveloper, developer: validateDeveloperMessage(obj, path))
  of RoleSystem: result = Message(kind: MkSystem, system: validateSystemMessage(obj, path))
  of RoleAssistant: result = Message(kind: MkAssistant, assistant: validateAssistantMessage(obj, path))
  of RoleUser: result = Message(kind: MkUser, user: validateUserMessage(obj, path))
  of RoleTool: result = Message(kind: MkTool, tool: validateToolMessage(obj, path))

proc validateTool*(node: JsonNode, path: string): Tool =
  let obj = validateObjectKeys(node, path, ["name", "description"])
  result.name = validateString(obj["name"], fmt"{path}.name")
  result.description = validateString(obj["description"], fmt"{path}.description")
  result.parameters = obj.getOrDefault("parameters")
  if result.parameters == nil: result.parameters = newJObject()

proc validateRunAgentInput*(node: JsonNode): RunAgentInput =
  let obj = validateObjectKeys(node, "input", ["threadId", "runId"])
  result.threadId = validateString(obj["threadId"], "input.threadId")
  result.runId = validateString(obj["runId"], "input.runId")
  result.state = obj.getOrDefault("state")
  if result.state == nil: result.state = newJObject()
  if obj.hasKey("messages"):
    for i, msgNode in validateArray(obj["messages"], "input.messages"):
      result.messages.add(validateMessage(msgNode, fmt"input.messages[{i}]"))
  if obj.hasKey("tools"):
    for i, toolNode in validateArray(obj["tools"], "input.tools"):
      result.tools.add(validateTool(toolNode, fmt"input.tools[{i}]"))
  if obj.hasKey("context"):
    for i, ctxNode in validateArray(obj["context"], "input.context"):
      result.context.add(Context(
        description: validateString(ctxNode["description"], fmt"input.context[{i}].description"),
        value: validateString(ctxNode["value"], fmt"input.context[{i}].value")
      ))
  result.forwardedProps = obj.getOrDefault("forwardedProps")
  if result.forwardedProps == nil: result.forwardedProps = newJObject()

proc validateEvent*(node: JsonNode): BaseEvent =
  let obj = validateObject(node, "event")
  let eventTypeStr = validateString(obj["type"], "event.type")
  let eventType = parseEnum[EventType](eventTypeStr)
  
  # Base fields
  let timestamp = if obj.hasKey("timestamp") and obj["timestamp"].kind != JNull: some(obj["timestamp"].getBiggestInt) else: none(int64)
  let rawEvent = if obj.hasKey("rawEvent") and obj["rawEvent"].kind != JNull: some(obj["rawEvent"]) else: none(JsonNode)

  case eventType
  of TEXT_MESSAGE_START:
    result = TextMessageStartEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"),
      role: validateString(obj["role"], "event.role"))
  of TEXT_MESSAGE_CONTENT:
    result = TextMessageContentEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"),
      delta: validateString(obj["delta"], "event.delta"))
  of TEXT_MESSAGE_END:
    result = TextMessageEndEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"))
  of TEXT_MESSAGE_CHUNK:
    result = TextMessageChunkEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateOptionalString(obj.getOrDefault("messageId"), "event.messageId"),
      role: validateOptionalString(obj.getOrDefault("role"), "event.role"),
      delta: validateOptionalString(obj.getOrDefault("delta"), "event.delta"))
  of THINKING_TEXT_MESSAGE_START:
    result = ThinkingTextMessageStartEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent)
  of THINKING_TEXT_MESSAGE_CONTENT:
    result = ThinkingTextMessageContentEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      delta: validateString(obj["delta"], "event.delta"))
  of THINKING_TEXT_MESSAGE_END:
    result = ThinkingTextMessageEndEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent)
  of TOOL_CALL_START:
    result = ToolCallStartEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      toolCallId: validateString(obj["toolCallId"], "event.toolCallId"),
      toolCallName: validateString(obj["toolCallName"], "event.toolCallName"),
      parentMessageId: validateOptionalString(obj.getOrDefault("parentMessageId"), "event.parentMessageId"))
  of TOOL_CALL_ARGS:
    result = ToolCallArgsEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      toolCallId: validateString(obj["toolCallId"], "event.toolCallId"),
      delta: validateString(obj["delta"], "event.delta"))
  of TOOL_CALL_END:
    result = ToolCallEndEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      toolCallId: validateString(obj["toolCallId"], "event.toolCallId"))
  of TOOL_CALL_CHUNK:
    result = ToolCallChunkEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      toolCallId: validateOptionalString(obj.getOrDefault("toolCallId"), "event.toolCallId"),
      toolCallName: validateOptionalString(obj.getOrDefault("toolCallName"), "event.toolCallName"),
      parentMessageId: validateOptionalString(obj.getOrDefault("parentMessageId"), "event.parentMessageId"),
      delta: validateOptionalString(obj.getOrDefault("delta"), "event.delta"))
  of TOOL_CALL_RESULT:
    result = ToolCallResultEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"),
      toolCallId: validateString(obj["toolCallId"], "event.toolCallId"),
      content: validateString(obj["content"], "event.content"),
      role: validateOptionalString(obj.getOrDefault("role"), "event.role"))
  of THINKING_START:
    result = ThinkingStartEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      title: validateOptionalString(obj.getOrDefault("title"), "event.title"))
  of THINKING_END:
    result = ThinkingEndEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent)
  of STATE_SNAPSHOT:
    result = StateSnapshotEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, snapshot: obj["snapshot"])
  of STATE_DELTA:
    result = StateDeltaEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, delta: @(validateJsonPatch(obj["delta"], "event.delta").elems))
  of MESSAGES_SNAPSHOT:
    var msgs: seq[Message] = @[]
    for i, n in validateArray(obj["messages"], "event.messages"): msgs.add(validateMessage(n, fmt"event.messages[{i}]"))
    result = MessagesSnapshotEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, messages: msgs)
  of ACTIVITY_SNAPSHOT:
    result = ActivitySnapshotEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"),
      activityType: validateString(obj["activityType"], "event.activityType"),
      content: obj["content"], replace: obj["replace"].getBool)
  of ACTIVITY_DELTA:
    result = ActivityDeltaEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"),
      activityType: validateString(obj["activityType"], "event.activityType"),
      patch: @(validateJsonPatch(obj["patch"], "event.patch").elems))
  of RAW:
    result = RawEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      event: obj["event"], source: validateOptionalString(obj.getOrDefault("source"), "event.source"))
  of CUSTOM:
    result = CustomEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      name: validateString(obj["name"], "event.name"), value: obj["value"])
  of RUN_STARTED:
    result = RunStartedEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      threadId: validateString(obj["threadId"], "event.threadId"), runId: validateString(obj["runId"], "event.runId"))
  of RUN_FINISHED:
    result = RunFinishedEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      threadId: validateString(obj["threadId"], "event.threadId"), runId: validateString(obj["runId"], "event.runId"))
  of RUN_ERROR:
    result = RunErrorEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      message: validateString(obj["message"], "event.message"), code: validateOptionalString(obj.getOrDefault("code"), "event.code"))
  of STEP_STARTED:
    result = StepStartedEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, stepName: validateString(obj["stepName"], "event.stepName"))
  of STEP_FINISHED:
    result = StepFinishedEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, stepName: validateString(obj["stepName"], "event.stepName"))
  of REASONING_START:
    result = ReasoningStartEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, messageId: validateString(obj["messageId"], "event.messageId"))
  of REASONING_MESSAGE_START:
    result = ReasoningMessageStartEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"), role: validateString(obj["role"], "event.role"))
  of REASONING_MESSAGE_CONTENT:
    result = ReasoningMessageContentEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateString(obj["messageId"], "event.messageId"), delta: validateString(obj["delta"], "event.delta"))
  of REASONING_MESSAGE_END:
    result = ReasoningMessageEndEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, messageId: validateString(obj["messageId"], "event.messageId"))
  of REASONING_MESSAGE_CHUNK:
    result = ReasoningMessageChunkEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      messageId: validateOptionalString(obj.getOrDefault("messageId"), "event.messageId"),
      delta: validateOptionalString(obj.getOrDefault("delta"), "event.delta"))
  of REASONING_END:
    result = ReasoningEndEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent, messageId: validateString(obj["messageId"], "event.messageId"))
  of REASONING_ENCRYPTED_VALUE:
    result = ReasoningEncryptedValueEvent(`type`: eventType, timestamp: timestamp, rawEvent: rawEvent,
      subtype: validateString(obj["subtype"], "event.subtype"),
      entityId: validateString(obj["entityId"], "event.entityId"),
      encryptedValue: validateString(obj["encryptedValue"], "event.encryptedValue"))
