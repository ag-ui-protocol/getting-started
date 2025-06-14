import unittest
import json
import options
import ../src/ag_ui_nim/core/types

suite "Types Module - Complete Coverage":
  test "All Role enum values":
    check $RoleDeveloper == "developer"
    check $RoleSystem == "system"
    check $RoleUser == "user"
    check $RoleAssistant == "assistant"
    check $RoleTool == "tool"

  test "All MessageKind enum values":
    check $MkDeveloper == "MkDeveloper"
    check $MkSystem == "MkSystem"
    check $MkUser == "MkUser"
    check $MkAssistant == "MkAssistant"
    check $MkTool == "MkTool"

  test "DeveloperMessage toJson and fromJson":
    let msg = DeveloperMessage(
      id: "dev123",
      role: RoleDeveloper,
      content: some("test developer message"),
      name: some("dev_name")
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "dev123"
    check jsonNode["role"].getStr() == "developer"
    check jsonNode["content"].getStr() == "test developer message"
    check jsonNode["name"].getStr() == "dev_name"
    
    let parsed = jsonNode.fromJson(DeveloperMessage)
    check parsed.id == "dev123"
    check parsed.role == RoleDeveloper
    check parsed.content.get() == "test developer message"
    check parsed.name.get() == "dev_name"

  test "SystemMessage toJson and fromJson":
    let msg = SystemMessage(
      id: "sys123",
      role: RoleSystem,
      content: some("test system message"),
      name: none(string)
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "sys123"
    check jsonNode["role"].getStr() == "system"
    check jsonNode["content"].getStr() == "test system message"
    check not jsonNode.hasKey("name")
    
    let parsed = jsonNode.fromJson(SystemMessage)
    check parsed.id == "sys123"
    check parsed.role == RoleSystem
    check parsed.content.get() == "test system message"
    check parsed.name.isNone

  test "UserMessage fromJson":
    let jsonStr = """{"id": "user123", "role": "user", "content": "test user message"}"""
    let jsonNode = parseJson(jsonStr)
    let msg = jsonNode.fromJson(UserMessage)
    check msg.id == "user123"
    check msg.role == RoleUser
    check msg.content.get() == "test user message"

  test "AssistantMessage fromJson":
    let jsonStr = """{"id": "asst123", "role": "assistant", "content": "test assistant message"}"""
    let jsonNode = parseJson(jsonStr)
    let msg = jsonNode.fromJson(AssistantMessage)
    check msg.id == "asst123"
    check msg.role == RoleAssistant
    check msg.content.get() == "test assistant message"

  test "AssistantMessage with toolCalls fromJson":
    let jsonStr = """{"id": "asst123", "role": "assistant", "content": "test", "toolCalls": [{"id": "tc1", "type": "function", "function": {"name": "test_fn", "arguments": "args"}}]}"""
    let jsonNode = parseJson(jsonStr)
    let msg = jsonNode.fromJson(AssistantMessage)
    check msg.id == "asst123"
    check msg.toolCalls.isSome
    check msg.toolCalls.get().len == 1
    check msg.toolCalls.get()[0].id == "tc1"

  test "ToolMessage toJson and fromJson":
    let msg = ToolMessage(
      id: "tool123",
      role: RoleTool,
      content: "tool result",
      toolCallId: "call456"
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "tool123"
    check jsonNode["role"].getStr() == "tool"
    check jsonNode["content"].getStr() == "tool result"
    check jsonNode["toolCallId"].getStr() == "call456"
    
    let parsed = jsonNode.fromJson(ToolMessage)
    check parsed.id == "tool123"
    check parsed.role == RoleTool
    check parsed.content == "tool result"
    check parsed.toolCallId == "call456"

  test "FunctionCall fromJson":
    let jsonStr = """{"name": "test_function", "arguments": "test args"}"""
    let jsonNode = parseJson(jsonStr)
    let fc = jsonNode.fromJson(FunctionCall)
    check fc.name == "test_function"
    check fc.arguments == "test args"

  test "ToolCall fromJson":
    let jsonStr = """{"id": "tool123", "type": "function", "function": {"name": "fn", "arguments": "args"}}"""
    let jsonNode = parseJson(jsonStr)
    let tc = jsonNode.fromJson(ToolCall)
    check tc.id == "tool123"
    check tc.`type` == "function"
    check tc.function.name == "fn"
    check tc.function.arguments == "args"

  test "Context toJson and fromJson":
    let context = Context(
      description: "Test context",
      value: "Test value"
    )
    let jsonNode = context.toJson()
    check jsonNode["description"].getStr() == "Test context"
    check jsonNode["value"].getStr() == "Test value"
    
    let parsed = jsonNode.fromJson(Context)
    check parsed.description == "Test context"
    check parsed.value == "Test value"

  test "Tool toJson and fromJson":
    let tool = Tool(
      name: "TestTool",
      description: "A test tool",
      parameters: %*{"type": "object", "properties": {}}
    )
    let jsonNode = tool.toJson()
    check jsonNode["name"].getStr() == "TestTool"
    check jsonNode["description"].getStr() == "A test tool"
    check jsonNode["parameters"]["type"].getStr() == "object"
    
    let parsed = jsonNode.fromJson(Tool)
    check parsed.name == "TestTool"
    check parsed.description == "A test tool"
    check parsed.parameters["type"].getStr() == "object"

  test "RunAgentInput toJson":
    let input = RunAgentInput(
      threadId: "thread123",
      runId: "run456",
      state: %*{"key": "value"},
      messages: @[],
      tools: @[Tool(name: "tool1", description: "desc", parameters: %*{})],
      context: @[Context(description: "ctx", value: "val")],
      forwardedProps: %*{"prop": "value"}
    )
    let jsonNode = input.toJson()
    check jsonNode["threadId"].getStr() == "thread123"
    check jsonNode["runId"].getStr() == "run456"
    check jsonNode["state"]["key"].getStr() == "value"
    check jsonNode["tools"].len == 1
    check jsonNode["context"].len == 1
    check jsonNode["forwardedProps"]["prop"].getStr() == "value"

  test "Message variant - DeveloperMessage":
    var msg = Message(kind: MkDeveloper)
    msg.developer = DeveloperMessage(
      id: "dev",
      role: RoleDeveloper,
      content: some("dev msg"),
      name: none(string)
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "dev"
    check jsonNode["role"].getStr() == "developer"

  test "Message variant - SystemMessage":
    var msg = Message(kind: MkSystem)
    msg.system = SystemMessage(
      id: "sys",
      role: RoleSystem,
      content: some("sys msg"),
      name: none(string)
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "sys"
    check jsonNode["role"].getStr() == "system"

  test "Message variant - AssistantMessage":
    var msg = Message(kind: MkAssistant)
    msg.assistant = AssistantMessage(
      id: "asst",
      role: RoleAssistant,
      content: some("assistant msg"),
      name: none(string),
      toolCalls: none(seq[ToolCall])
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "asst"
    check jsonNode["role"].getStr() == "assistant"

  test "Message variant - UserMessage":
    var msg = Message(kind: MkUser)
    msg.user = UserMessage(
      id: "usr",
      role: RoleUser,
      content: some("user msg"),
      name: none(string)
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "usr"
    check jsonNode["role"].getStr() == "user"

  test "Message variant - ToolMessage":
    var msg = Message(kind: MkTool)
    msg.tool = ToolMessage(
      id: "tool",
      role: RoleTool,
      content: "result",
      toolCallId: "call123"
    )
    let jsonNode = msg.toJson()
    check jsonNode["id"].getStr() == "tool"
    check jsonNode["role"].getStr() == "tool"
    check jsonNode["content"].getStr() == "result"

  test "BaseMessage fromJson with all fields":
    let jsonStr = """{"id": "base123", "role": "user", "content": "content", "name": "username"}"""
    let jsonNode = parseJson(jsonStr)
    let msg = jsonNode.fromJson(UserMessage)
    check msg.id == "base123"
    check msg.role == RoleUser
    check msg.content.isSome
    check msg.content.get() == "content"
    check msg.name.isSome
    check msg.name.get() == "username"

  test "BaseMessage fromJson with minimal fields":
    let jsonStr = """{"id": "base456", "role": "assistant"}"""
    let jsonNode = parseJson(jsonStr)
    let msg = jsonNode.fromJson(AssistantMessage)
    check msg.id == "base456"
    check msg.role == RoleAssistant
    check msg.content.isNone
    check msg.name.isNone

  test "FunctionCall toJson":
    let fc = FunctionCall(name: "test_function", arguments: """{"param": "value"}""")
    let jsonNode = fc.toJson()
    check jsonNode["name"].getStr() == "test_function"
    check jsonNode["arguments"].getStr() == """{"param": "value"}"""

  test "ToolCall toJson":
    let tc = ToolCall(
      id: "tc123",
      `type`: "function",
      function: FunctionCall(name: "my_func", arguments: "args")
    )
    let jsonNode = tc.toJson()
    check jsonNode["id"].getStr() == "tc123"
    check jsonNode["type"].getStr() == "function"
    check jsonNode["function"]["name"].getStr() == "my_func"
    check jsonNode["function"]["arguments"].getStr() == "args"

  test "newRunAgentInput constructor":
    let messages = @[
      Message(kind: MkUser, user: UserMessage(id: "u1", role: RoleUser, content: some("test"), name: none(string)))
    ]
    let tools = @[Tool(name: "tool1", description: "desc", parameters: %*{"type": "object"})]
    let context = @[Context(description: "ctx", value: "val")]
    
    let input = newRunAgentInput(
      threadId = "thread123",
      runId = "run456",
      state = %*{"key": "value"},
      messages = messages,
      tools = tools,
      context = context,
      forwardedProps = %*{"prop": "value"}
    )
    
    check input.threadId == "thread123"
    check input.runId == "run456"
    check input.state["key"].getStr() == "value"
    check input.messages.len == 1
    check input.tools.len == 1
    check input.context.len == 1
    check input.forwardedProps["prop"].getStr() == "value"

  test "newContext constructor":
    let ctx = newContext("Test description", "Test value")
    check ctx.description == "Test description"
    check ctx.value == "Test value"

  test "newTool constructor":
    let tool = newTool("TestTool", "A test tool", %*{"type": "object", "properties": {}})
    check tool.name == "TestTool"
    check tool.description == "A test tool"
    check tool.parameters["type"].getStr() == "object"

  test "Constructor methods coverage":
    # Test all new* constructor methods
    let devMsg = newDeveloperMessage("dev1", "dev content", some("dev_name"))
    check devMsg.id == "dev1"
    check devMsg.content.get() == "dev content"
    check devMsg.name.get() == "dev_name"

    let sysMsg = newSystemMessage("sys1", "sys content", none(string))
    check sysMsg.id == "sys1"
    check sysMsg.content.get() == "sys content"
    check sysMsg.name.isNone

    let userMsg = newUserMessage("user1", "user content", some("username"))
    check userMsg.id == "user1"
    check userMsg.content.get() == "user content"
    check userMsg.name.get() == "username"

    let assistMsg = newAssistantMessage("asst1", some("asst content"), none(seq[ToolCall]), none(string))
    check assistMsg.id == "asst1"
    check assistMsg.content.get() == "asst content"
    check assistMsg.name.isNone
    check assistMsg.toolCalls.isNone

    let toolMsg = newToolMessage("tool1", "result", "call123")
    check toolMsg.id == "tool1"
    check toolMsg.content == "result"
    check toolMsg.toolCallId == "call123"

  test "AssistantMessage with toolCalls constructor":
    let toolCalls = @[
      ToolCall(id: "tc1", `type`: "function", function: FunctionCall(name: "fn", arguments: "args"))
    ]
    let assistMsg = newAssistantMessage("asst2", some("content"), some(toolCalls), none(string))
    check assistMsg.id == "asst2"
    check assistMsg.toolCalls.isSome
    check assistMsg.toolCalls.get().len == 1
    check assistMsg.toolCalls.get()[0].id == "tc1"

  test "newFunctionCall and newToolCall constructors":
    let fc = newFunctionCall("test_func", """{"param": "value"}""")
    check fc.name == "test_func"
    check fc.arguments == """{"param": "value"}"""

    let tc = newToolCall("tc456", "function", fc)
    check tc.id == "tc456"
    check tc.`type` == "function"
    check tc.function.name == "test_func"
    check tc.function.arguments == """{"param": "value"}"""

