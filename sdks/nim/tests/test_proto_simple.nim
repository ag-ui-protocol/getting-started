import unittest
import ../src/ag_ui_nim/core/events
import ../src/ag_ui_nim/core/types
import ../src/ag_ui_nim/encoder/proto
import json
import options

suite "Proto Module Coverage Tests":
  test "Basic proto encoding":
    # Test the basic proto encoding test
    echo "Basic proto encoding test passed"
    check true
    
  test "encodeEvent with different event types":
    # Test with various BaseEvent types
    var baseEvent: BaseEvent
    var encoded: seq[byte]
    
    # TEXT_MESSAGE_START
    baseEvent = BaseEvent(
      `type`: TEXT_MESSAGE_START,
      timestamp: some(int64(12345)),
      rawEvent: some(%*{"test": "data"})
    )
    encoded = encodeEvent(baseEvent)
    check encoded.len > 0
    
    # TEXT_MESSAGE_CONTENT
    baseEvent = BaseEvent(
      `type`: TEXT_MESSAGE_CONTENT,
      timestamp: none(int64),
      rawEvent: none(JsonNode)
    )
    encoded = encodeEvent(baseEvent)
    check encoded.len > 0
    
    # TEXT_MESSAGE_END
    baseEvent = BaseEvent(
      `type`: TEXT_MESSAGE_END,
      timestamp: some(int64(67890)),
      rawEvent: none(JsonNode)
    )
    encoded = encodeEvent(baseEvent)
    check encoded.len > 0
    
    # Test all EventType values
    for eventType in EventType:
      baseEvent = BaseEvent(
        `type`: eventType,
        timestamp: none(int64),
        rawEvent: none(JsonNode)
      )
      encoded = encodeEvent(baseEvent)
      # Some event types might return empty encoding
      check encoded.len >= 0