import unittest
import ag_ui_nim

proc testChunkTransform() =
  test "transformChunks should convert text chunks to proper events":
    let chunks = @[
      newTextMessageChunkEvent("msg1", "assistant", "Hello"),
      newTextMessageChunkEvent("msg1", "assistant", ", world!")
    ]
    
    let events = transformChunks(chunks)
    
    check(events.len == 4)  # start, content, content, end
    check(events[0].type == EventType.TEXT_MESSAGE_START)
    check(events[1].type == EventType.TEXT_MESSAGE_CONTENT)
    check(events[2].type == EventType.TEXT_MESSAGE_CONTENT)
    check(events[3].type == EventType.TEXT_MESSAGE_END)
    
    let startEvent = cast[TextMessageStartEvent](events[0])
    check(startEvent.messageId == "msg1")
    check(startEvent.role == "assistant")
    
    let contentEvent1 = cast[TextMessageContentEvent](events[1])
    check(contentEvent1.messageId == "msg1")
    check(contentEvent1.content == "Hello")
    
    let contentEvent2 = cast[TextMessageContentEvent](events[2])
    check(contentEvent2.messageId == "msg1")
    check(contentEvent2.content == ", world!")
    
    let endEvent = cast[TextMessageEndEvent](events[3])
    check(endEvent.messageId == "msg1")
  
  test "transformChunks should convert tool call chunks to proper events":
    let chunks = @[
      newToolCallChunkEvent("tc1", "search", "msg1", """{"q":"""),
      newToolCallChunkEvent("tc1", "search", "msg1", """ "nim"}""")
    ]
    
    let events = transformChunks(chunks)
    
    check(events.len == 4)  # start, args, args, end
    check(events[0].type == EventType.TOOL_CALL_START)
    check(events[1].type == EventType.TOOL_CALL_ARGS)
    check(events[2].type == EventType.TOOL_CALL_ARGS)
    check(events[3].type == EventType.TOOL_CALL_END)
    
    let startEvent = cast[ToolCallStartEvent](events[0])
    check(startEvent.toolCallId == "tc1")
    check(startEvent.toolCallName == "search")
    check(startEvent.parentMessageId.get() == "msg1")
    
    let argsEvent1 = cast[ToolCallArgsEvent](events[1])
    check(argsEvent1.toolCallId == "tc1")
    check(argsEvent1.args == """{"q":""")
    
    let argsEvent2 = cast[ToolCallArgsEvent](events[2])
    check(argsEvent2.toolCallId == "tc1")
    check(argsEvent2.args == """ "nim"}""")
    
    let endEvent = cast[ToolCallEndEvent](events[3])
    check(endEvent.toolCallId == "tc1")
  
  test "transformChunks should handle interleaved chunks":
    let chunks = @[
      newTextMessageChunkEvent("msg1", "assistant", "Hello"),
      newToolCallChunkEvent("tc1", "search", "msg1", """{"q": "nim"}"""),
      newTextMessageChunkEvent("msg2", "assistant", "Result:")
    ]
    
    let events = transformChunks(chunks)
    
    check(events.len == 7)  # msg1-start, msg1-content, msg1-end, tc1-start, tc1-args, tc1-end, msg2-start
    
    # First message and its end
    check(events[0].type == EventType.TEXT_MESSAGE_START)
    check(events[1].type == EventType.TEXT_MESSAGE_CONTENT)
    check(events[2].type == EventType.TEXT_MESSAGE_END)
    
    # Tool call
    check(events[3].type == EventType.TOOL_CALL_START)
    check(events[4].type == EventType.TOOL_CALL_ARGS)
    check(events[5].type == EventType.TOOL_CALL_END)
    
    # Second message start
    check(events[6].type == EventType.TEXT_MESSAGE_START)

proc testSSEParser() =
  test "parseSSEStream should parse simple events":
    var parser = newSSEParser()
    let data = "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n"
    
    let events = parseSSEStream(data, parser)
    
    check(events.len == 1)
    check(events[0].data == "{\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}")
  
  test "parseSSEStream should handle multi-line data":
    var parser = newSSEParser()
    let data = "data: line1\ndata: line2\n\n"
    
    let events = parseSSEStream(data, parser)
    
    check(events.len == 1)
    check(events[0].data == "line1\nline2")
  
  test "parseSSEStream should handle incomplete events":
    var parser = newSSEParser()
    let data1 = "data: {\"type\":\"TEXT_MESSAGE_START\""
    let data2 = ",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n"
    
    let events1 = parseSSEStream(data1, parser)
    check(events1.len == 0)  # No complete events yet
    
    let events2 = parseSSEStream(data2, parser)
    check(events2.len == 1)
    check(events2[0].data == "{\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}")
  
  test "parseSSEStream should handle multiple events":
    var parser = newSSEParser()
    let data = "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n" &
               "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg1\",\"content\":\"Hello\"}\n\n"
    
    let events = parseSSEStream(data, parser)
    
    check(events.len == 2)
    check(events[0].data == "{\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}")
    check(events[1].data == "{\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg1\",\"content\":\"Hello\"}")

when isMainModule:
  testChunkTransform()
  testSSEParser()