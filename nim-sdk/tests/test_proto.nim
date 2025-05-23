import unittest
import ../src/ag_ui_nim/core/events
import ../src/ag_ui_nim/encoder/proto
import options
import json

proc testBasicProtoEncoding() =
  test "encodeEvent should create a valid byte sequence":
    # Create a simple event with rawEvent data
    let rawEvent = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg1",
      "role": "assistant"
    }
    
    var event = BaseEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      rawEvent: some(rawEvent)
    )
    
    let encoded = encodeEvent(event)
    check(encoded.len > 0)
    
    # Try a simple JSON event encoding to ensure it works
    event.type = EventType.TEXT_MESSAGE_END
    let encoded2 = encodeEvent(event)
    check(encoded2.len > 0)
    
    echo "Basic proto encoding test passed"

when isMainModule:
  testBasicProtoEncoding()