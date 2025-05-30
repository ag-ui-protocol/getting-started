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
  ## This is a basic implementation focusing on common schema features
  let obj = validateObject(node, path)
  
  # Check for required type field which is common in JSON Schema
  if obj.hasKey("type"):
    let typeNode = obj["type"]
    if typeNode.kind != JString and typeNode.kind != JArray:
      raise newValidationError(fmt"{path}.type", 
                              fmt"{path}.type must be a string or array of strings",
                              TypeMismatch, "string or array", $typeNode.kind)
    
    if typeNode.kind == JArray:
      for i in 0..<typeNode.len:
        if typeNode[i].kind != JString:
          raise newValidationError(fmt"{path}.type[{i}]", 
                                  fmt"{path}.type[{i}] must be a string",
                                  TypeMismatch, "string", $typeNode[i].kind)
  
  # Validate properties if present
  if obj.hasKey("properties") and obj["properties"].kind != JNull:
    let props = validateObject(obj["properties"], fmt"{path}.properties")
    
    # We need to iterate over properties differently
    var k = ""
    for key, val in props:
      k = key  # Get the property name
      if val.kind != JObject:
        raise newValidationError(fmt"{path}.properties.{k}", 
                                fmt"{path}.properties.{k} must be an object",
                                TypeMismatch, "object", $val.kind)
      discard validateJsonSchema(val, fmt"{path}.properties.{k}")
  
  # Validate required fields if present
  if obj.hasKey("required") and obj["required"].kind != JNull:
    let req = validateArray(obj["required"], fmt"{path}.required")
    for i in 0..<req.len:
      if req[i].kind != JString:
        raise newValidationError(fmt"{path}.required[{i}]", 
                                fmt"{path}.required[{i}] must be a string",
                                TypeMismatch, "string", $req[i].kind)
  
  # Return the validated schema
  result = obj

proc validateJsonPatchOperation*(op: JsonNode, path: string, index: int): JsonNode =
  ## Validate a single JSON Patch operation
  let opPath = fmt"{path}[{index}]"
  let obj = validateObject(op, opPath)
  
  # Validate required fields
  if not obj.hasKey("op"):
    raise newValidationError(fmt"{opPath}.op", 
                            fmt"Required field 'op' is missing in {opPath}",
                            Missing)
  
  if obj["op"].kind != JString:
    raise newValidationError(fmt"{opPath}.op", 
                            fmt"{opPath}.op must be a string",
                            TypeMismatch, "string", $obj["op"].kind)
  
  let operation = obj["op"].getStr()
  # Validate operation value
  let validOps = ["add", "remove", "replace", "move", "copy", "test"]
  let validOpsStr = validOps.join(", ")
  if operation notin validOps:
    raise newValidationError(fmt"{opPath}.op", 
                            fmt"{opPath}.op has invalid value: '{operation}'. Valid values are: {validOpsStr}",
                            InvalidValue)
  
  # All operations require a path
  if not obj.hasKey("path"):
    raise newValidationError(fmt"{opPath}.path", 
                            fmt"Required field 'path' is missing in {opPath}",
                            Missing)
  
  if obj["path"].kind != JString:
    raise newValidationError(fmt"{opPath}.path", 
                            fmt"{opPath}.path must be a string",
                            TypeMismatch, "string", $obj["path"].kind)
  
  # Operation-specific validation
  case operation
  of "add", "replace", "test":
    # These operations require a value
    if not obj.hasKey("value"):
      raise newValidationError(fmt"{opPath}.value", 
                              fmt"Required field 'value' is missing in {opPath} for operation '{operation}'",
                              Missing)
  
  of "move", "copy":
    # These operations require a from field
    if not obj.hasKey("from"):
      raise newValidationError(fmt"{opPath}.from", 
                              fmt"Required field 'from' is missing in {opPath} for operation '{operation}'",
                              Missing)
    
    if obj["from"].kind != JString:
      raise newValidationError(fmt"{opPath}.from", 
                              fmt"{opPath}.from must be a string",
                              TypeMismatch, "string", $obj["from"].kind)
  
  of "remove":
    # Remove doesn't have additional requirements beyond path
    discard
  
  else:
    # We already validated the operation earlier, so this shouldn't happen
    discard

  # Return the validated operation
  result = obj

proc validateJsonPatch*(node: JsonNode, path: string): JsonNode =
  ## Validate an array of JSON Patch operations
  ## JSON Patch is defined in RFC 6902
  let arr = validateArray(node, path)
  
  for i in 0..<arr.len:
    discard validateJsonPatchOperation(arr[i], path, i)
  
  # Return the validated patch array
  result = arr

proc validateFunctionCallParameters*(node: JsonNode, path: string): JsonNode =
  ## Validate parameters for a function call
  ## This validates that the structure is a valid JSON object
  ## that could be used for parameters
  let obj = validateObject(node, path)
  
  # Validate common function parameter fields
  if obj.hasKey("type") and obj["type"].kind != JNull:
    let typeVal = validateString(obj["type"], fmt"{path}.type")
    # For objects, validate the properties field if present
    if typeVal == "object" and obj.hasKey("properties"):
      let props = validateObject(obj["properties"], fmt"{path}.properties")
      # Validate each property definition
      for propName, propDef in props:
        if propDef.kind != JObject:
          raise newValidationError(fmt"{path}.properties.{propName}", 
                                  fmt"{path}.properties.{propName} must be an object",
                                  TypeMismatch, "object", $propDef.kind)
  
  # Return the validated parameters
  result = obj

proc validateFunctionCall*(node: JsonNode, path: string): FunctionCall =
  ## Validate that a JSON node is a valid FunctionCall
  let obj = validateObjectKeys(node, path, ["name", "arguments"])
  
  # Validate name field - should be a non-empty string
  let name = validateString(obj["name"], fmt"{path}.name")
  if name.len == 0:
    raise newValidationError(fmt"{path}.name", 
                            fmt"{path}.name must not be empty",
                            InvalidValue)
  
  # Validate arguments field - should be a valid JSON string
  let args = validateString(obj["arguments"], fmt"{path}.arguments")
  
  # Attempt to parse arguments as JSON to validate it's properly formatted
  try:
    discard parseJson(args)
    # Could do further validation on the structure if needed
  except:
    # If it's not valid JSON, raise a validation error
    raise newValidationError(fmt"{path}.arguments", 
                           fmt"{path}.arguments must be a valid JSON string",
                           InvalidValue)
  
  # Create and return the function call
  result.name = name
  result.arguments = args

proc validateToolCall*(node: JsonNode, path: string): ToolCall =
  ## Validate that a JSON node is a valid ToolCall
  let obj = validateObjectKeys(node, path, ["id", "type", "function"])
  
  # Validate id field - should be a non-empty string
  let id = validateString(obj["id"], fmt"{path}.id")
  if id.len == 0:
    raise newValidationError(fmt"{path}.id", 
                            fmt"{path}.id must not be empty",
                            InvalidValue)
  
  # Validate type field - must be "function" for now
  let typeStr = validateString(obj["type"], fmt"{path}.type")
  if typeStr != "function":
    raise newValidationError(fmt"{path}.type", 
                           fmt"{path}.type must be 'function', got '{typeStr}'",
                           InvalidValue)
  
  # Validate function field
  let function = validateFunctionCall(obj["function"], fmt"{path}.function")
  
  # Create and return the tool call
  result.id = id
  result.`type` = typeStr
  result.function = function

proc validateBaseMessage*(node: JsonNode, path: string): BaseMessage =
  ## Validate that a JSON node is a valid BaseMessage
  let obj = validateObject(node, path)
  result.id = validateString(obj["id"], fmt"{path}.id")
  result.role = validateEnum[Role](obj["role"], fmt"{path}.role")
  
  if obj.hasKey("content") and obj["content"].kind != JNull:
    result.content = some(validateString(obj["content"], fmt"{path}.content"))
  else:
    result.content = none(string)
  
  if obj.hasKey("name") and obj["name"].kind != JNull:
    result.name = some(validateString(obj["name"], fmt"{path}.name"))
  else:
    result.name = none(string)

proc validateDeveloperMessage*(node: JsonNode, path: string): DeveloperMessage =
  ## Validate developer message
  result = DeveloperMessage(validateBaseMessage(node, path))

proc validateSystemMessage*(node: JsonNode, path: string): SystemMessage =
  ## Validate system message
  result = SystemMessage(validateBaseMessage(node, path))

proc validateAssistantMessage*(node: JsonNode, path: string): AssistantMessage =
  ## Validate assistant message
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
  ## Validate user message
  result = UserMessage(validateBaseMessage(node, path))

proc validateToolMessage*(node: JsonNode, path: string): ToolMessage =
  ## Validate tool message
  let obj = validateObject(node, path)
  result.id = validateString(obj["id"], fmt"{path}.id")
  result.role = validateEnum[Role](obj["role"], fmt"{path}.role")
  result.content = validateString(obj["content"], fmt"{path}.content")
  result.toolCallId = validateString(obj["toolCallId"], fmt"{path}.toolCallId")

proc validateMessage*(node: JsonNode, path: string): Message =
  ## Validate that a JSON node is a valid Message
  let obj = validateObject(node, path)
  let role = validateEnum[Role](obj["role"], fmt"{path}.role")
  
  case role
  of RoleDeveloper:
    let developer = validateDeveloperMessage(obj, path)
    result = Message(kind: MkDeveloper, developer: developer)
  of RoleSystem:
    let system = validateSystemMessage(obj, path)
    result = Message(kind: MkSystem, system: system)
  of RoleAssistant:
    let assistant = validateAssistantMessage(obj, path)
    result = Message(kind: MkAssistant, assistant: assistant)
  of RoleUser:
    let user = validateUserMessage(obj, path)
    result = Message(kind: MkUser, user: user)
  of RoleTool:
    let tool = validateToolMessage(obj, path)
    result = Message(kind: MkTool, tool: tool)

proc validateTool*(node: JsonNode, path: string): Tool =
  ## Validate that a JSON node is a valid Tool
  let obj = validateObjectKeys(node, path, ["name", "description"])
  
  # Validate name field - should be a non-empty string
  let name = validateString(obj["name"], fmt"{path}.name")
  if name.len == 0:
    raise newValidationError(fmt"{path}.name", 
                            fmt"{path}.name must not be empty",
                            InvalidValue)
  
  # Validate description field - should be a string
  let description = validateString(obj["description"], fmt"{path}.description")
  
  # Validate parameters field if present
  var parameters = newJObject()
  if obj.hasKey("parameters") and obj["parameters"].kind != JNull:
    # For now, just validate that it's an object since JSON Schema validation
    # is complex and could have many variants
    if obj["parameters"].kind != JObject:
      raise newValidationError(fmt"{path}.parameters", 
                             fmt"{path}.parameters must be an object",
                             TypeMismatch, "object", $obj["parameters"].kind)
    parameters = obj["parameters"]
  
  # Create and return the tool
  result = Tool(
    name: name,
    description: description,
    parameters: parameters
  )

proc validateRunAgentInput*(node: JsonNode): RunAgentInput =
  ## Validate that a JSON node is a valid RunAgentInput
  let obj = validateObjectKeys(node, "input", ["threadId", "runId"])
  result.threadId = validateString(obj["threadId"], "input.threadId")
  result.runId = validateString(obj["runId"], "input.runId")
  
  # State is any valid JSON
  if obj.hasKey("state") and obj["state"].kind != JNull:
    result.state = obj["state"]
  else:
    result.state = newJObject() # Default to empty object if not present
  
  # Messages array
  if obj.hasKey("messages") and obj["messages"].kind != JNull:
    let messagesArray = validateArray(obj["messages"], "input.messages")
    for i, messageNode in messagesArray:
      result.messages.add(validateMessage(messageNode, fmt"input.messages[{i}]"))
  
  # Tools array
  if obj.hasKey("tools") and obj["tools"].kind != JNull:
    let toolsArray = validateArray(obj["tools"], "input.tools")
    for i, toolNode in toolsArray:
      let tool = validateTool(toolNode, fmt"input.tools[{i}]")
      result.tools.add(tool)
  
  # Context array
  if obj.hasKey("context") and obj["context"].kind != JNull:
    let contextArray = validateArray(obj["context"], "input.context")
    for i, contextNode in contextArray:
      let context = Context(
        description: validateString(contextNode["description"], fmt"input.context[{i}].description"),
        value: validateString(contextNode["value"], fmt"input.context[{i}].value")
      )
      result.context.add(context)
  
  # Forwarded props
  if obj.hasKey("forwardedProps") and obj["forwardedProps"].kind != JNull:
    result.forwardedProps = obj["forwardedProps"]
  else:
    result.forwardedProps = newJObject() # Default to empty object if not present

proc validateEvent*(node: JsonNode): BaseEvent =
  ## Validate and parse a JSON node into the appropriate event type
  let obj = validateObject(node, "event")
  let eventTypeStr = validateString(obj["type"], "event.type")
  let eventType = parseEnum[EventType](eventTypeStr)
  
  # Create base event and set common fields
  result = BaseEvent(`type`: eventType)
  if obj.hasKey("timestamp") and obj["timestamp"].kind != JNull:
    result.timestamp = some(obj["timestamp"].getBiggestInt)
  if obj.hasKey("rawEvent") and obj["rawEvent"].kind != JNull:
    result.rawEvent = some(obj["rawEvent"])
  
  case eventType
  of EventType.TEXT_MESSAGE_START:
    let messageId = validateString(obj["messageId"], "event.messageId")
    let role = validateString(obj["role"], "event.role")
    result = TextMessageStartEvent(
      `type`: eventType,
      messageId: messageId,
      role: role,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.TEXT_MESSAGE_CONTENT:
    let messageId = validateString(obj["messageId"], "event.messageId")
    let delta = validateString(obj["delta"], "event.delta")
    result = TextMessageContentEvent(
      `type`: eventType,
      messageId: messageId,
      delta: delta,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.TEXT_MESSAGE_END:
    let messageId = validateString(obj["messageId"], "event.messageId")
    result = TextMessageEndEvent(
      `type`: eventType,
      messageId: messageId,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.TEXT_MESSAGE_CHUNK:
    let messageId = validateString(obj["messageId"], "event.messageId")
    let role = validateString(obj["role"], "event.role")
    let content = validateString(obj["content"], "event.content")
    result = TextMessageChunkEvent(
      `type`: eventType,
      messageId: messageId,
      role: role,
      content: content,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.TOOL_CALL_START:
    let toolCallId = validateString(obj["toolCallId"], "event.toolCallId")
    let toolCallName = validateString(obj["toolCallName"], "event.toolCallName")
    var parentMessageId = none(string)
    if obj.hasKey("parentMessageId") and obj["parentMessageId"].kind != JNull:
      parentMessageId = some(validateString(obj["parentMessageId"], "event.parentMessageId"))
    result = ToolCallStartEvent(
      `type`: eventType,
      toolCallId: toolCallId,
      toolCallName: toolCallName,
      parentMessageId: parentMessageId,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.TOOL_CALL_ARGS:
    let toolCallId = validateString(obj["toolCallId"], "event.toolCallId")
    let delta = validateString(obj["delta"], "event.delta")
    result = ToolCallArgsEvent(
      `type`: eventType,
      toolCallId: toolCallId,
      delta: delta,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.TOOL_CALL_END:
    let toolCallId = validateString(obj["toolCallId"], "event.toolCallId")
    result = ToolCallEndEvent(
      `type`: eventType,
      toolCallId: toolCallId,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.TOOL_CALL_CHUNK:
    let toolCallId = validateString(obj["toolCallId"], "event.toolCallId")
    let toolCallName = validateString(obj["toolCallName"], "event.toolCallName")
    let args = validateString(obj["args"], "event.args")
    var parentMessageId = none(string)
    if obj.hasKey("parentMessageId") and obj["parentMessageId"].kind != JNull:
      parentMessageId = some(validateString(obj["parentMessageId"], "event.parentMessageId"))
    result = ToolCallChunkEvent(
      `type`: eventType,
      toolCallId: toolCallId,
      toolCallName: toolCallName,
      parentMessageId: parentMessageId,
      args: args,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.STATE_SNAPSHOT:
    result = StateSnapshotEvent(
      `type`: eventType,
      snapshot: obj["snapshot"],
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.STATE_DELTA:
    if not obj.hasKey("delta"):
      raise newValidationError("event.delta", 
                           "Required field 'delta' is missing in event",
                           Missing)
    
    # Validate the delta as a JSON Patch (RFC 6902)
    let patchOps = validateJsonPatch(obj["delta"], "event.delta")
    
    # Convert to seq[JsonNode]
    var operations: seq[JsonNode] = @[]
    for op in patchOps:
      operations.add(op)
    
    result = StateDeltaEvent(
      `type`: eventType,
      delta: operations,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.MESSAGES_SNAPSHOT:
    let messagesArray = validateArray(obj["messages"], "event.messages")
    var messages: seq[Message] = @[]
    for i, msgNode in messagesArray:
      messages.add(validateMessage(msgNode, fmt"event.messages[{i}]"))
    result = MessagesSnapshotEvent(
      `type`: eventType,
      messages: messages,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.RAW:
    let event = validateObject(obj["event"], "event.event")
    var source = none(string)
    if obj.hasKey("source") and obj["source"].kind != JNull:
      source = some(validateString(obj["source"], "event.source"))
    result = RawEvent(
      `type`: eventType,
      event: event,
      source: source,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.CUSTOM:
    let name = validateString(obj["name"], "event.name")
    let value = validateObject(obj["value"], "event.value")
    result = CustomEvent(
      `type`: eventType,
      name: name,
      value: value,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.RUN_STARTED:
    let threadId = validateString(obj["threadId"], "event.threadId")
    let runId = validateString(obj["runId"], "event.runId")
    result = RunStartedEvent(
      `type`: eventType,
      threadId: threadId,
      runId: runId,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.RUN_FINISHED:
    let threadId = validateString(obj["threadId"], "event.threadId")
    let runId = validateString(obj["runId"], "event.runId")
    result = RunFinishedEvent(
      `type`: eventType,
      threadId: threadId,
      runId: runId,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.RUN_ERROR:
    let message = validateString(obj["message"], "event.message")
    var code = none(string)
    if obj.hasKey("code") and obj["code"].kind != JNull:
      code = some(validateString(obj["code"], "event.code"))
    result = RunErrorEvent(
      `type`: eventType,
      message: message,
      code: code,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.STEP_STARTED:
    let stepName = validateString(obj["stepName"], "event.stepName")
    result = StepStartedEvent(
      `type`: eventType,
      stepName: stepName,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )
  
  of EventType.STEP_FINISHED:
    let stepName = validateString(obj["stepName"], "event.stepName")
    result = StepFinishedEvent(
      `type`: eventType,
      stepName: stepName,
      timestamp: result.timestamp,
      rawEvent: result.rawEvent
    )