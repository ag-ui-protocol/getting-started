import unittest
import ../src/ag_ui_nim/core/types
import ../src/ag_ui_nim/core/events
import ../src/ag_ui_nim/client/verify
import options
import json

proc testVerifyEvents() =
  test "verifyEvents should accept valid event sequences":
    # Create an event with rawEvent to store all properties
    let rawEvent = %*{
      "type": "RUN_STARTED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let startedEvent = RunStartedEvent(
      `type`: EventType.RUN_STARTED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(rawEvent)
    )
    
    let events: seq[BaseEvent] = @[
      BaseEvent(startedEvent)
    ]
    
    let result = verifyEvents(events)
    check(result.len == 1)

  test "verifyEvents should accept valid text message sequences":
    # Create start event
    let startRawEvent = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg1",
      "role": "assistant"
    }
    
    let startEvent = TextMessageStartEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
      rawEvent: some(startRawEvent)
    )
    
    # Create end event
    let endRawEvent = %*{
      "type": "TEXT_MESSAGE_END",
      "messageId": "msg1"
    }
    
    let endEvent = TextMessageEndEvent(
      `type`: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
      rawEvent: some(endRawEvent)
    )
    
    let events: seq[BaseEvent] = @[
      BaseEvent(startEvent),
      BaseEvent(endEvent)
    ]
    
    let result = verifyEvents(events)
    check(result.len == 2)

  test "verifyEvents should reject invalid text message sequences":
    # Create start event for msg1
    let startRawEvent1 = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg1",
      "role": "assistant"
    }
    
    let startEvent1 = TextMessageStartEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
      rawEvent: some(startRawEvent1)
    )
    
    # Create start event for msg2 without closing msg1
    let startRawEvent2 = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg2",
      "role": "assistant"
    }
    
    let startEvent2 = TextMessageStartEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
      role: "assistant",
      rawEvent: some(startRawEvent2)
    )
    
    let events: seq[BaseEvent] = @[
      BaseEvent(startEvent1),
      BaseEvent(startEvent2)
    ]
    
    expect VerifyError:
      discard verifyEvents(events)

when isMainModule:
  testVerifyEvents()