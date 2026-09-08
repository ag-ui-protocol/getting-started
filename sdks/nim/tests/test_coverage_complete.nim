import unittest
import json
import options
import ../src/ag_ui_nim/core/types
import ../src/ag_ui_nim/core/events
import ../src/ag_ui_nim/encoder/encoder
import ../src/ag_ui_nim/encoder/proto

suite "100% Coverage Tests":
  test "Types - All Role enum values":
    # Test all role enum values
    check $RoleDeveloper == "developer"
    check $RoleSystem == "system"
    check $RoleAssistant == "assistant"
    check $RoleUser == "user"
    check $RoleTool == "tool"
    
  test "Types - All message kinds and constructors":
    # Test all message types that weren't covered
    let devMsg = newDeveloperMessage("dev1", "Developer content", some("devname"))
    check devMsg.id == "dev1"
    check devMsg.role == RoleDeveloper
    check devMsg.content.get == "Developer content"
    check devMsg.name.get == "devname"
    
    let sysMsg = newSystemMessage("sys1", "System content", some("sysname"))
    check sysMsg.id == "sys1"
    check sysMsg.role == RoleSystem
    check sysMsg.content.get == "System content"
    check sysMsg.name.get == "sysname"
    
    let toolMsg = newToolMessage("tool1", "Tool result", "call123")
    check toolMsg.id == "tool1"
    check toolMsg.role == RoleTool
    check toolMsg.content == "Tool result"
    check toolMsg.toolCallId == "call123"
    
  test "Types - toJson for all message types":
    # Test JSON conversion for all message types
    let devMsg = newDeveloperMessage("dev1", "Developer content", some("devname"))
    let devJson = devMsg.toJson()
    check devJson["id"].getStr == "dev1"
    check devJson["role"].getStr == "developer"
    check devJson["content"].getStr == "Developer content"
    check devJson["name"].getStr == "devname"
    
    let sysMsg = newSystemMessage("sys1", "System content", some("sysname"))
    let sysJson = sysMsg.toJson()
    check sysJson["id"].getStr == "sys1"
    check sysJson["role"].getStr == "system"
    check sysJson["content"].getStr == "System content"
    check sysJson["name"].getStr == "sysname"
    
    let toolMsg = newToolMessage("tool1", "Tool result", "call123")
    let toolJson = toolMsg.toJson()
    check toolJson["id"].getStr == "tool1"
    check toolJson["role"].getStr == "tool"
    check toolJson["content"].getStr == "Tool result"
    check toolJson["toolCallId"].getStr == "call123"
    
  test "Types - Message union with all kinds":
    # Test Message union type with all kinds
    var msg: Message
    
    # Developer message
    msg = Message(kind: MkDeveloper, developer: newDeveloperMessage("dev1", "content"))
    let devJson = msg.toJson()
    check devJson["id"].getStr == "dev1"
    check devJson["role"].getStr == "developer"
    
    # System message
    msg = Message(kind: MkSystem, system: newSystemMessage("sys1", "content"))
    let sysJson = msg.toJson()
    check sysJson["id"].getStr == "sys1"
    check sysJson["role"].getStr == "system"
    
    # Tool message
    msg = Message(kind: MkTool, tool: newToolMessage("tool1", "content", "call123"))
    let toolJson = msg.toJson()
    check toolJson["id"].getStr == "tool1"
    check toolJson["role"].getStr == "tool"
    
  test "Types - fromJson for all message types":
    # Test fromJson for all types
    var json = %*{
      "name": "testFunc",
      "arguments": "{\"arg\": \"value\"}"
    }
    let fc = fromJson(json, FunctionCall)
    check fc.name == "testFunc"
    check fc.arguments == "{\"arg\": \"value\"}"
    
    json = %*{
      "id": "call123",
      "type": "function",
      "function": {
        "name": "testFunc",
        "arguments": "{}"
      }
    }
    let tc = fromJson(json, ToolCall)
    check tc.id == "call123"
    check tc.`type` == "function"
    
    json = %*{
      "description": "Test context",
      "value": "context value"
    }
    let ctx = fromJson(json, Context)
    check ctx.description == "Test context"
    check ctx.value == "context value"
    
    json = %*{
      "name": "testTool",
      "description": "A test tool",
      "parameters": %*{"type": "object"}
    }
    let tool = fromJson(json, Tool)
    check tool.name == "testTool"
    check tool.description == "A test tool"
    
  test "Types - fromJson for all message subtypes":
    # Developer message
    var json = %*{
      "id": "dev1",
      "role": "developer",
      "content": "Developer content",
      "name": "devname"
    }
    let devMsg = fromJson(json, DeveloperMessage)
    check devMsg.id == "dev1"
    check devMsg.role == RoleDeveloper
    check devMsg.content.get == "Developer content"
    check devMsg.name.get == "devname"
    
    # System message
    json = %*{
      "id": "sys1",
      "role": "system",
      "content": "System content",
      "name": "sysname"
    }
    let sysMsg = fromJson(json, SystemMessage)
    check sysMsg.id == "sys1"
    check sysMsg.role == RoleSystem
    check sysMsg.content.get == "System content"
    check sysMsg.name.get == "sysname"
    
    # Assistant message with tool calls
    json = %*{
      "id": "asst1",
      "role": "assistant",
      "content": "Assistant content",
      "name": "asstname",
      "toolCalls": [{
        "id": "call1",
        "type": "function",
        "function": {
          "name": "func1",
          "arguments": "{}"
        }
      }]
    }
    let asstMsg = fromJson(json, AssistantMessage)
    check asstMsg.id == "asst1"
    check asstMsg.role == RoleAssistant
    check asstMsg.content.get == "Assistant content"
    check asstMsg.name.get == "asstname"
    check asstMsg.toolCalls.get.len == 1
    check asstMsg.toolCalls.get[0].id == "call1"
    
    # User message
    json = %*{
      "id": "user1",
      "role": "user",
      "content": "User content",
      "name": "username"
    }
    let userMsg = fromJson(json, UserMessage)
    check userMsg.id == "user1"
    check userMsg.role == RoleUser
    check userMsg.content.get == "User content"
    check userMsg.name.get == "username"
    
    # Tool message
    json = %*{
      "id": "tool1",
      "role": "tool",
      "content": "Tool content",
      "toolCallId": "call123"
    }
    let toolMsg = fromJson(json, ToolMessage)
    check toolMsg.id == "tool1"
    check toolMsg.role == RoleTool
    check toolMsg.content == "Tool content"
    check toolMsg.toolCallId == "call123"
    
  test "Types - RunAgentInput with all fields":
    # Test with context field populated
    let context = @[newContext("ctx1", "value1"), newContext("ctx2", "value2")]
    let input = newRunAgentInput("thread1", "run1", %*{"state": "test"}, 
                                 @[], @[], context, %*{"prop": "value"})
    check input.context.len == 2
    check input.context[0].description == "ctx1"
    
    # Test toJson
    let inputJson = input.toJson()
    check inputJson["threadId"].getStr == "thread1"
    check inputJson["runId"].getStr == "run1"
    check inputJson["context"].len == 2
    check inputJson["context"][0]["description"].getStr == "ctx1"
    
  test "Types - toJson for Context and Tool":
    let ctx = newContext("Test description", "Test value")
    let ctxJson = ctx.toJson()
    check ctxJson["description"].getStr == "Test description"
    check ctxJson["value"].getStr == "Test value"
    
    let tool = newTool("testTool", "A test tool", %*{"type": "object"})
    let toolJson = tool.toJson()
    check toolJson["name"].getStr == "testTool"
    check toolJson["description"].getStr == "A test tool"
    check toolJson["parameters"]["type"].getStr == "object"
    
  test "Types - AssistantMessage with tool calls toJson":
    let fc = newFunctionCall("func1", "{\"arg\": \"value\"}")
    let tc = newToolCall("call1", "function", fc)
    let msg = newAssistantMessage("asst1", some("content"), some(@[tc]), some("name"))
    
    let json = msg.toJson()
    check json["id"].getStr == "asst1"
    check json["role"].getStr == "assistant"
    check json["content"].getStr == "content"
    check json["name"].getStr == "name"
    check json["toolCalls"].len == 1
    check json["toolCalls"][0]["id"].getStr == "call1"
    
  test "Types - Optional fields handling":
    # Test messages without optional fields
    let devMsg = newDeveloperMessage("dev1", "content", none(string))
    let devJson = devMsg.toJson()
    check not devJson.hasKey("name")
    
    let sysMsg = newSystemMessage("sys1", "content", none(string))
    let sysJson = sysMsg.toJson()
    check not sysJson.hasKey("name")
    
    let asstMsg = newAssistantMessage("asst1", none(string), none(seq[ToolCall]), none(string))
    let asstJson = asstMsg.toJson()
    check not asstJson.hasKey("content")
    check not asstJson.hasKey("name")
    check not asstJson.hasKey("toolCalls")
    
    let userMsg = newUserMessage("user1", "content", none(string))
    let userJson = userMsg.toJson()
    check not userJson.hasKey("name")
    
  test "Types - fromJson with missing optional fields":
    # Test fromJson with minimal fields
    var json = %*{
      "id": "dev1",
      "role": "developer"
    }
    let devMsg = fromJson(json, DeveloperMessage)
    check devMsg.id == "dev1"
    check devMsg.content.isNone
    check devMsg.name.isNone
    
    json = %*{
      "id": "sys1",
      "role": "system"
    }
    let sysMsg = fromJson(json, SystemMessage)
    check sysMsg.id == "sys1"
    check sysMsg.content.isNone
    check sysMsg.name.isNone
    
    json = %*{
      "id": "asst1",
      "role": "assistant"
    }
    let asstMsg = fromJson(json, AssistantMessage)
    check asstMsg.id == "asst1"
    check asstMsg.content.isNone
    check asstMsg.name.isNone
    check asstMsg.toolCalls.isNone
    
    json = %*{
      "id": "user1",
      "role": "user"
    }
    let userMsg = fromJson(json, UserMessage)
    check userMsg.id == "user1"
    check userMsg.content.isNone
    check userMsg.name.isNone