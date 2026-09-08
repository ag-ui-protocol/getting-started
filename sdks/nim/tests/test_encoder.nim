import unittest, json, options, strutils
import ../src/ag_ui_nim/encoder/encoder
import ../src/ag_ui_nim/core/[types, events]

suite "Encoder Module Tests":
  
  test "EventEncoder creation and content type":
    let encoder = newEventEncoder()
    check encoder.getContentType() == "text/event-stream"
  
  test "EventEncoder with protobuf accept (placeholder)":
    # Currently protobuf is not implemented, but the infrastructure is in place
    let encoder = newEventEncoder("application/vnd.ag-ui.event+proto")
    check encoder.getContentType() == "text/event-stream"  # Still SSE for now
  
  test "Encode TextMessageStartEvent":
    let encoder = newEventEncoder()
    let event = newTextMessageStartEvent("msg-001", "assistant")
    let encoded = encoder.encode(event)
    
    check encoded.startsWith("data: ")
    check encoded.endsWith("\n\n")
    
    # Extract and verify JSON content
    let jsonStr = encoded[6..^3]  # Remove "data: " prefix and "\n\n" suffix
    let json = parseJson(jsonStr)
    check json["type"].getStr() == "TEXT_MESSAGE_START"
    check json["messageId"].getStr() == "msg-001"
    check json["role"].getStr() == "assistant"
  
  test "Encode TextMessageContentEvent":
    let encoder = newEventEncoder()
    let event = newTextMessageContentEvent("msg-001", "Hello world")
    let encoded = encoder.encode(event)
    
    check encoded.startsWith("data: ")
    check encoded.endsWith("\n\n")
    
    let jsonStr = encoded[6..^3]
    let json = parseJson(jsonStr)
    check json["type"].getStr() == "TEXT_MESSAGE_CONTENT"
    check json["messageId"].getStr() == "msg-001"
    check json["delta"].getStr() == "Hello world"
  
  test "Encode MessagesSnapshotEvent":
    let encoder = newEventEncoder()
    
    let msg1 = newUserMessage("msg-001", "Hello")
    let msg2 = newAssistantMessage("msg-002", some("Hi there"))
    let messages = @[
      Message(kind: MkUser, user: msg1),
      Message(kind: MkAssistant, assistant: msg2)
    ]
    let event = newMessagesSnapshotEvent(messages)
    let encoded = encoder.encode(event)
    
    check encoded.startsWith("data: ")
    check encoded.endsWith("\n\n")
    
    let jsonStr = encoded[6..^3]
    let json = parseJson(jsonStr)
    check json["type"].getStr() == "MESSAGES_SNAPSHOT"
    check json["messages"].len == 2
    check json["messages"][0]["role"].getStr() == "user"
    check json["messages"][1]["role"].getStr() == "assistant"
  
  test "Encode RunErrorEvent with optional fields":
    let encoder = newEventEncoder()
    let event = newRunErrorEvent("Something went wrong", some("ERR_001"))
    let encoded = encoder.encode(event)
    
    check encoded.startsWith("data: ")
    check encoded.endsWith("\n\n")
    
    let jsonStr = encoded[6..^3]
    let json = parseJson(jsonStr)
    check json["type"].getStr() == "RUN_ERROR"
    check json["message"].getStr() == "Something went wrong"
    check json["code"].getStr() == "ERR_001"
  
  test "Encode Event union type":
    let encoder = newEventEncoder()
    let tmStart = newTextMessageStartEvent("msg-001", "assistant")
    let event = Event(kind: EkTextMessageStart, textMessageStart: tmStart)
    let encoded = encoder.encode(event)
    
    check encoded.startsWith("data: ")
    check encoded.endsWith("\n\n")
    
    let jsonStr = encoded[6..^3]
    let json = parseJson(jsonStr)
    check json["type"].getStr() == "TEXT_MESSAGE_START"
    check json["messageId"].getStr() == "msg-001"
  
  test "Encode event with timestamp":
    let encoder = newEventEncoder()
    let event = newTextMessageStartEvent("msg-001", "assistant", 
                                        some(1234567890'i64))
    let encoded = encoder.encode(event)
    
    let jsonStr = encoded[6..^3]
    let json = parseJson(jsonStr)
    check json["timestamp"].getBiggestInt() == 1234567890
  
  test "Encode special characters in JSON":
    let encoder = newEventEncoder()
    let event = newTextMessageContentEvent("msg-001", 
      """Hello "world"! 
      New line and \t tab""")
    let encoded = encoder.encode(event)
    
    check encoded.startsWith("data: ")
    check encoded.endsWith("\n\n")
    
    # Parse and verify the JSON handles special characters correctly
    let jsonStr = encoded[6..^3]
    let json = parseJson(jsonStr)
    check json["delta"].getStr() == """Hello "world"! 
      New line and \t tab"""