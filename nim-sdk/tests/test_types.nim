import unittest, json, options, strutils
import ../src/ag_ui_nim/core/types

suite "Types Module Tests":
  
  test "FunctionCall creation and JSON serialization":
    let fc = newFunctionCall("my_function", """{"param": "value"}""")
    check fc.name == "my_function"
    check fc.arguments == """{"param": "value"}"""
    
    let json = fc.toJson()
    check json["name"].getStr() == "my_function"
    check json["arguments"].getStr() == """{"param": "value"}"""
  
  test "ToolCall creation and JSON serialization":
    let fc = newFunctionCall("my_function", """{"param": "value"}""")
    let tc = newToolCall("tool-123", "function", fc)
    check tc.id == "tool-123"
    check tc.`type` == "function"
    
    let json = tc.toJson()
    check json["id"].getStr() == "tool-123"
    check json["type"].getStr() == "function"
    check json["function"]["name"].getStr() == "my_function"
  
  test "DeveloperMessage creation and JSON serialization":
    let msg = newDeveloperMessage("msg-001", "Developer instructions")
    check msg.id == "msg-001"
    check msg.role == RoleDeveloper
    check msg.content.get() == "Developer instructions"
    
    let json = msg.toJson()
    check json["id"].getStr() == "msg-001"
    check json["role"].getStr() == "developer"
    check json["content"].getStr() == "Developer instructions"
  
  test "SystemMessage creation and JSON serialization":
    let msg = newSystemMessage("msg-002", "System prompt")
    check msg.id == "msg-002"
    check msg.role == RoleSystem
    check msg.content.get() == "System prompt"
    
    let json = msg.toJson()
    check json["id"].getStr() == "msg-002"
    check json["role"].getStr() == "system"
    check json["content"].getStr() == "System prompt"
  
  test "AssistantMessage with tool calls":
    let fc = newFunctionCall("my_function", """{"param": "value"}""")
    let tc = newToolCall("tool-123", "function", fc)
    let msg = newAssistantMessage("msg-003", none(string), some(@[tc]))
    
    check msg.id == "msg-003"
    check msg.role == RoleAssistant
    check msg.content.isNone
    check msg.toolCalls.get().len == 1
    
    let json = msg.toJson()
    check json["id"].getStr() == "msg-003"
    check json["role"].getStr() == "assistant"
    check not json.hasKey("content")
    check json["toolCalls"].len == 1
    check json["toolCalls"][0]["id"].getStr() == "tool-123"
  
  test "UserMessage creation and JSON serialization":
    let msg = newUserMessage("msg-004", "Hello, how can you help?")
    check msg.id == "msg-004"
    check msg.role == RoleUser
    check msg.content.get() == "Hello, how can you help?"
    
    let json = msg.toJson()
    check json["id"].getStr() == "msg-004"
    check json["role"].getStr() == "user"
    check json["content"].getStr() == "Hello, how can you help?"
  
  test "ToolMessage creation and JSON serialization":
    let msg = newToolMessage("msg-005", "Function result", "tool-123")
    check msg.id == "msg-005"
    check msg.role == RoleTool
    check msg.content == "Function result"
    check msg.toolCallId == "tool-123"
    
    let json = msg.toJson()
    check json["id"].getStr() == "msg-005"
    check json["role"].getStr() == "tool"
    check json["content"].getStr() == "Function result"
    check json["toolCallId"].getStr() == "tool-123"
  
  test "Context creation and JSON serialization":
    let ctx = newContext("API Key", "secret-value")
    check ctx.description == "API Key"
    check ctx.value == "secret-value"
    
    let json = ctx.toJson()
    check json["description"].getStr() == "API Key"
    check json["value"].getStr() == "secret-value"
  
  test "Tool creation and JSON serialization":
    let params = %*{"type": "object", "properties": {"text": {"type": "string"}}}
    let tool = newTool("search", "Search the web", params)
    check tool.name == "search"
    check tool.description == "Search the web"
    
    let json = tool.toJson()
    check json["name"].getStr() == "search"
    check json["description"].getStr() == "Search the web"
    check json["parameters"] == params
  
  test "Message union type":
    let userMsg = newUserMessage("msg-001", "Hello")
    let message = Message(kind: MkUser, user: userMsg)
    
    let json = message.toJson()
    check json["id"].getStr() == "msg-001"
    check json["role"].getStr() == "user"
    check json["content"].getStr() == "Hello"
  
  test "RunAgentInput creation":
    let userMsg = newUserMessage("msg-001", "Hello")
    let messages = @[Message(kind: MkUser, user: userMsg)]
    let tool = newTool("search", "Search tool", %*{})
    let tools = @[tool]
    let ctx = newContext("key", "value")
    let context = @[ctx]
    let state = %*{"count": 1}
    let props = %*{"metadata": "test"}
    
    let input = newRunAgentInput("thread-123", "run-456", state, messages,
                                 tools, context, props)
    
    check input.threadId == "thread-123"
    check input.runId == "run-456"
    check input.messages.len == 1
    check input.tools.len == 1
    check input.context.len == 1
    
    let json = input.toJson()
    check json["threadId"].getStr() == "thread-123"
    check json["runId"].getStr() == "run-456"
    check json["messages"].len == 1
    check json["tools"].len == 1
    check json["context"].len == 1

  test "JSON round-trip for FunctionCall":
    let original = newFunctionCall("testFunc", """{"arg": 123}""")
    let json = original.toJson()
    let restored = fromJson(json, FunctionCall)
    
    check restored.name == original.name
    check restored.arguments == original.arguments
  
  test "JSON round-trip for ToolCall":
    let fc = newFunctionCall("func", """{"key": "val"}""")
    let original = newToolCall("id123", "function", fc)
    let json = original.toJson()
    let restored = fromJson(json, ToolCall)
    
    check restored.id == original.id
    check restored.`type` == original.`type`
    check restored.function.name == original.function.name
  
  test "JSON round-trip for Context":
    let original = newContext("desc", "val")
    let json = original.toJson()
    let restored = fromJson(json, Context)
    
    check restored.description == original.description
    check restored.value == original.value
  
  test "JSON round-trip for Tool":
    let params = %*{"type": "object"}
    let original = newTool("mytool", "Tool desc", params)
    let json = original.toJson()
    let restored = fromJson(json, Tool)
    
    check restored.name == original.name
    check restored.description == original.description
    check restored.parameters == original.parameters
  
  test "Message fromJson for all types":
    # Test DeveloperMessage
    let devJson = %*{"id": "d1", "role": "developer", "content": "Dev message"}
    let devMsg = fromJson(devJson, DeveloperMessage)
    check devMsg.id == "d1"
    check devMsg.role == RoleDeveloper
    check devMsg.content.get() == "Dev message"
    
    # Test SystemMessage
    let sysJson = %*{"id": "s1", "role": "system", "content": "System message", "name": "sys"}
    let sysMsg = fromJson(sysJson, SystemMessage)
    check sysMsg.id == "s1"
    check sysMsg.role == RoleSystem
    check sysMsg.content.get() == "System message"
    check sysMsg.name.get() == "sys"
    
    # Test UserMessage
    let userJson = %*{"id": "u1", "role": "user", "content": "User message"}
    let userMsg = fromJson(userJson, UserMessage)
    check userMsg.id == "u1"
    check userMsg.role == RoleUser
    check userMsg.content.get() == "User message"
  
  test "JSON with missing optional fields":
    # Message without name field
    let msgJson = %*{"id": "m1", "role": "developer", "content": "Test"}
    let msg = fromJson(msgJson, DeveloperMessage)
    check msg.name.isNone
    
    # AssistantMessage without toolCalls
    let asstJson = %*{"id": "a1", "role": "assistant"}
    let asstMsg = fromJson(asstJson, AssistantMessage)
    check asstMsg.content.isNone
    check asstMsg.toolCalls.isNone
  
  test "Large JSON payload handling":
    let largeString = "x".repeat(10000)
    let msg = newUserMessage("large", largeString)
    let json = msg.toJson()
    check json["content"].getStr().len == 10000
    
    # Round trip
    let restored = fromJson(json, UserMessage)
    check restored.content.get().len == 10000
  
  test "Complex nested structures":
    # Create complex RunAgentInput
    let toolCalls = @[
      newToolCall("tc1", "function", newFunctionCall("f1", """{"a": 1}""")),
      newToolCall("tc2", "function", newFunctionCall("f2", """{"b": 2}"""))
    ]
    
    let messages = @[
      Message(kind: MkUser, user: newUserMessage("u1", "Query")),
      Message(kind: MkAssistant, assistant: newAssistantMessage("a1", none(string), some(toolCalls))),
      Message(kind: MkTool, tool: newToolMessage("t1", "Result", "tc1"))
    ]
    
    let tools = @[
      newTool("tool1", "First tool", %*{"type": "object"}),
      newTool("tool2", "Second tool", %*{"type": "array"})
    ]
    
    let context = @[
      newContext("env", "production"),
      newContext("region", "us-west-2")
    ]
    
    let state = %*{
      "counter": 42,
      "flags": {"debug": true, "verbose": false},
      "items": ["a", "b", "c"]
    }
    
    let input = newRunAgentInput("thread-1", "run-1", state, messages, tools, context, %*{"meta": "data"})
    let json = input.toJson()
    
    # Verify complex structure
    check json["messages"].len == 3
    check json["messages"][1]["toolCalls"].len == 2
    check json["tools"].len == 2
    check json["context"].len == 2
    check json["state"]["flags"]["debug"].getBool() == true
    check json["state"]["items"].len == 3
  
  test "Role enum string conversion":
    check $RoleDeveloper == "developer"
    check $RoleSystem == "system"
    check $RoleAssistant == "assistant"
    check $RoleUser == "user"
    check $RoleTool == "tool"
  
  test "Edge cases":
    # Empty string content
    let emptyMsg = newUserMessage("e1", "")
    check emptyMsg.content.get() == ""
    
    # Empty arrays
    let emptyToolCalls: seq[ToolCall] = @[]
    let noTools = newAssistantMessage("a1", some("Hi"), some(emptyToolCalls))
    check noTools.toolCalls.get().len == 0
    
    # Null JSON values
    let nullState: State = newJNull()
    let withNull = newRunAgentInput("t1", "r1", nullState, @[], @[], @[], %*{})
    check withNull.state.kind == JNull

# Tests run automatically when this module is executed