import unittest
import ag_ui_nim
import options

proc testLegacyTypes() =
  test "LegacyRuntimeProtocolEvent toJson":
    let event = LegacyTextMessageStart(
      threadId: "t1",
      runId: "r1",
      messageId: "msg1",
      role: "assistant"
    )
    
    let protocolEvent = LegacyRuntimeProtocolEvent(
      eventType: TextMessageStart,
      textMessageStart: event
    )
    
    let json = toJson(protocolEvent)
    
    check(json.kind == JObject)
    check(json["type"].getStr() == "text_message_start")
    check(json["threadId"].getStr() == "t1")
    check(json["runId"].getStr() == "r1")
    check(json["messageId"].getStr() == "msg1")
    check(json["role"].getStr() == "assistant")

proc testLegacyConvert() =
  test "convertToLegacyEvent should convert TextMessageStartEvent":
    let event = newTextMessageStartEvent("msg1", "assistant")
    let legacyEventOpt = convertToLegacyEvent(event, "t1", "r1")
    
    check(legacyEventOpt.isSome)
    
    let legacyEvent = legacyEventOpt.get()
    check(legacyEvent.eventType == TextMessageStart)
    check(legacyEvent.textMessageStart.threadId == "t1")
    check(legacyEvent.textMessageStart.runId == "r1")
    check(legacyEvent.textMessageStart.messageId == "msg1")
    check(legacyEvent.textMessageStart.role == "assistant")
  
  test "convertToLegacyEvent should convert ToolCallStartEvent":
    let event = newToolCallStartEvent("tc1", "search", some("msg1"))
    let legacyEventOpt = convertToLegacyEvent(event, "t1", "r1")
    
    check(legacyEventOpt.isSome)
    
    let legacyEvent = legacyEventOpt.get()
    check(legacyEvent.eventType == ActionExecutionStart)
    check(legacyEvent.actionExecutionStart.threadId == "t1")
    check(legacyEvent.actionExecutionStart.runId == "r1")
    check(legacyEvent.actionExecutionStart.actionId == "tc1")
    check(legacyEvent.actionExecutionStart.action == "search")
  
  test "convertToLegacyEvent should convert StateSnapshotEvent":
    let state = %*{"counter": 42}
    let event = newStateSnapshotEvent(state)
    let legacyEventOpt = convertToLegacyEvent(event, "t1", "r1")
    
    check(legacyEventOpt.isSome)
    
    let legacyEvent = legacyEventOpt.get()
    check(legacyEvent.eventType == MetaEvent)
    check(legacyEvent.metaEvent.threadId == "t1")
    check(legacyEvent.metaEvent.runId == "r1")
    check(legacyEvent.metaEvent.name == "state_snapshot")
    check(legacyEvent.metaEvent.payload.kind == JObject)
    check(legacyEvent.metaEvent.payload["counter"].getInt() == 42)
  
  test "convertToStandardEvent should convert TextMessageStart":
    let legacy = LegacyTextMessageStart(
      threadId: "t1",
      runId: "r1",
      messageId: "msg1",
      role: "assistant"
    )
    
    let legacyEvent = LegacyRuntimeProtocolEvent(
      eventType: TextMessageStart,
      textMessageStart: legacy
    )
    
    let stdEventOpt = convertToStandardEvent(legacyEvent)
    
    check(stdEventOpt.isSome)
    
    let stdEvent = stdEventOpt.get()
    check(stdEvent.type == EventType.TEXT_MESSAGE_START)
    
    let startEvent = cast[TextMessageStartEvent](stdEvent)
    check(startEvent.messageId == "msg1")
    check(startEvent.role == "assistant")
  
  test "convertToStandardEvent should convert ActionExecutionStart":
    let legacy = LegacyActionExecutionStart(
      threadId: "t1",
      runId: "r1",
      actionId: "tc1",
      action: "search"
    )
    
    let legacyEvent = LegacyRuntimeProtocolEvent(
      eventType: ActionExecutionStart,
      actionExecutionStart: legacy
    )
    
    let stdEventOpt = convertToStandardEvent(legacyEvent)
    
    check(stdEventOpt.isSome)
    
    let stdEvent = stdEventOpt.get()
    check(stdEvent.type == EventType.TOOL_CALL_START)
    
    let startEvent = cast[ToolCallStartEvent](stdEvent)
    check(startEvent.toolCallId == "tc1")
    check(startEvent.toolCallName == "search")

when isMainModule:
  testLegacyTypes()
  testLegacyConvert()