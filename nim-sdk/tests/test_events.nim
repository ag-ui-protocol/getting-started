import unittest, json, options
import ../src/ag_ui_nim/core/[types, events]

suite "Events Module Tests":
  
  test "TextMessageStartEvent creation and JSON serialization":
    let event = newTextMessageStartEvent("msg-001", "assistant")
    check event.`type` == TEXT_MESSAGE_START
    check event.messageId == "msg-001"
    check event.role == "assistant"
    
    let json = event.toJson()
    check json["type"].getStr() == "TEXT_MESSAGE_START"
    check json["messageId"].getStr() == "msg-001"
    check json["role"].getStr() == "assistant"
  
  test "TextMessageContentEvent with validation":
    # Valid event
    let event = newTextMessageContentEvent("msg-001", "Hello")
    check event.`type` == TEXT_MESSAGE_CONTENT
    check event.messageId == "msg-001"
    check event.delta == "Hello"
    
    # Should throw exception for empty delta
    expect ValueError:
      discard newTextMessageContentEvent("msg-001", "")
  
  test "TextMessageEndEvent creation":
    let event = newTextMessageEndEvent("msg-001")
    check event.`type` == TEXT_MESSAGE_END
    check event.messageId == "msg-001"
    
    let json = event.toJson()
    check json["type"].getStr() == "TEXT_MESSAGE_END"
    check json["messageId"].getStr() == "msg-001"
  
  test "ToolCallStartEvent with parentMessageId":
    let event = newToolCallStartEvent("tool-001", "search", some("msg-001"))
    check event.`type` == TOOL_CALL_START
    check event.toolCallId == "tool-001"
    check event.toolCallName == "search"
    check event.parentMessageId.get() == "msg-001"
    
    let json = event.toJson()
    check json["type"].getStr() == "TOOL_CALL_START"
    check json["toolCallId"].getStr() == "tool-001"
    check json["toolCallName"].getStr() == "search"
    check json["parentMessageId"].getStr() == "msg-001"
  
  test "StateSnapshotEvent with JSON state":
    let state = %*{"count": 42, "name": "test"}
    let event = newStateSnapshotEvent(state)
    check event.`type` == STATE_SNAPSHOT
    check event.snapshot == state
    
    let json = event.toJson()
    check json["type"].getStr() == "STATE_SNAPSHOT"
    check json["snapshot"]["count"].getInt() == 42
    check json["snapshot"]["name"].getStr() == "test"
  
  test "StateDeltaEvent with JSON patches":
    let patches = @[
      %*{"op": "replace", "path": "/count", "value": 43},
      %*{"op": "add", "path": "/newField", "value": "new"}
    ]
    let event = newStateDeltaEvent(patches)
    check event.`type` == STATE_DELTA
    check event.delta.len == 2
    
    let json = event.toJson()
    check json["type"].getStr() == "STATE_DELTA"
    check json["delta"].len == 2
    check json["delta"][0]["op"].getStr() == "replace"
  
  test "MessagesSnapshotEvent with messages":
    let msg1 = newUserMessage("msg-001", "Hello")
    let msg2 = newAssistantMessage("msg-002", some("Hi there"))
    let messages = @[
      Message(kind: MkUser, user: msg1),
      Message(kind: MkAssistant, assistant: msg2)
    ]
    let event = newMessagesSnapshotEvent(messages)
    check event.`type` == MESSAGES_SNAPSHOT
    check event.messages.len == 2
    
    let json = event.toJson()
    check json["type"].getStr() == "MESSAGES_SNAPSHOT"
    check json["messages"].len == 2
    check json["messages"][0]["role"].getStr() == "user"
    check json["messages"][1]["role"].getStr() == "assistant"
  
  test "CustomEvent creation":
    let value = %*{"customData": "test"}
    let event = newCustomEvent("myCustomEvent", value)
    check event.`type` == CUSTOM
    check event.name == "myCustomEvent"
    check event.value == value
    
    let json = event.toJson()
    check json["type"].getStr() == "CUSTOM"
    check json["name"].getStr() == "myCustomEvent"
    check json["value"]["customData"].getStr() == "test"
  
  test "RunStartedEvent creation":
    let event = newRunStartedEvent("thread-123", "run-456")
    check event.`type` == RUN_STARTED
    check event.threadId == "thread-123"
    check event.runId == "run-456"
    
    let json = event.toJson()
    check json["type"].getStr() == "RUN_STARTED"
    check json["threadId"].getStr() == "thread-123"
    check json["runId"].getStr() == "run-456"
  
  test "RunErrorEvent with optional code":
    let event = newRunErrorEvent("Something went wrong", some("ERR_001"))
    check event.`type` == RUN_ERROR
    check event.message == "Something went wrong"
    check event.code.get() == "ERR_001"
    
    let json = event.toJson()
    check json["type"].getStr() == "RUN_ERROR"
    check json["message"].getStr() == "Something went wrong"
    check json["code"].getStr() == "ERR_001"
  
  test "Event union type":
    let tmStart = newTextMessageStartEvent("msg-001", "assistant")
    let event = Event(kind: EkTextMessageStart, textMessageStart: tmStart)
    
    let json = event.toJson()
    check json["type"].getStr() == "TEXT_MESSAGE_START"
    check json["messageId"].getStr() == "msg-001"
  
  test "Event with timestamp":
    let event = newTextMessageStartEvent("msg-001", "assistant", 
                                        some(1234567890'i64))
    check event.timestamp.get() == 1234567890'i64
    
    let json = event.toJson()
    check json["timestamp"].getBiggestInt() == 1234567890