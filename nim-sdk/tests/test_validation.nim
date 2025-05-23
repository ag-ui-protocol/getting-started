import unittest, json, options
import ../src/ag_ui_nim/core/[types, events, validation]

suite "Validation Module Tests":
  test "Validate simple string":
    let node = %"test"
    check validateString(node, "testPath") == "test"
  
  test "Validate enum":
    let node = %"assistant"
    check validateEnum[Role](node, "rolePath") == RoleAssistant
  
  test "Validate optional string":
    let node = %"test"
    check validateOptionalString(node, "testPath").get() == "test"
    
    let nullNode = newJNull()
    check validateOptionalString(nullNode, "testPath").isNone
  
  test "Validate basic TextMessageStartEvent":
    let jsonNode = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg-001",
      "role": "assistant"
    }
    
    let event = validateEvent(jsonNode)
    check event.`type` == TEXT_MESSAGE_START
    
    let tmStart = TextMessageStartEvent(event)
    check tmStart.messageId == "msg-001"
    check tmStart.role == "assistant"
  
  test "Validate simple RunAgentInput":
    let jsonNode = %*{
      "threadId": "thread-123",
      "runId": "run-456",
      "messages": [
        {
          "id": "msg-001",
          "role": "user",
          "content": "Hello"
        }
      ]
    }
    
    let input = validateRunAgentInput(jsonNode)
    check input.threadId == "thread-123"
    check input.runId == "run-456"
    check input.messages.len == 1