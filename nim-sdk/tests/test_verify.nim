import unittest
import ../src/ag_ui_nim/core/types
import ../src/ag_ui_nim/core/events
import ../src/ag_ui_nim/client/verify
import options
import json

proc testVerifyEvents() =
  test "verifyEvents should accept valid event sequences":
    # Create events with rawEvent data
    let startedRawEvent = %*{
      "type": "RUN_STARTED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let startedEvent = RunStartedEvent(
      `type`: EventType.RUN_STARTED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(startedRawEvent)
    )
    
    let msgStartRawEvent = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg1",
      "role": $RoleAssistant
    }
    
    let msgStartEvent = TextMessageStartEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: $RoleAssistant,
      rawEvent: some(msgStartRawEvent)
    )
    
    let msgContentRawEvent = %*{
      "type": "TEXT_MESSAGE_CONTENT",
      "messageId": "msg1",
      "delta": "Hello"
    }
    
    let msgContentEvent = TextMessageContentEvent(
      `type`: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Hello",
      rawEvent: some(msgContentRawEvent)
    )
    
    let msgEndRawEvent = %*{
      "type": "TEXT_MESSAGE_END",
      "messageId": "msg1"
    }
    
    let msgEndEvent = TextMessageEndEvent(
      `type`: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
      rawEvent: some(msgEndRawEvent)
    )
    
    let finishedRawEvent = %*{
      "type": "RUN_FINISHED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let finishedEvent = RunFinishedEvent(
      `type`: EventType.RUN_FINISHED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(finishedRawEvent)
    )
    
    let events: seq[BaseEvent] = @[
      BaseEvent(startedEvent),
      BaseEvent(msgStartEvent),
      BaseEvent(msgContentEvent),
      BaseEvent(msgEndEvent),
      BaseEvent(finishedEvent)
    ]
    
    let result = verifyEvents(events)
    check(result.len == 5)
  
  test "verifyEvents should throw on invalid event sequences":
    # Test message without proper start
    let startedRawEvent = %*{
      "type": "RUN_STARTED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let startedEvent = RunStartedEvent(
      `type`: EventType.RUN_STARTED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(startedRawEvent)
    )
    
    let msgContentRawEvent = %*{
      "type": "TEXT_MESSAGE_CONTENT",
      "messageId": "msg1",
      "delta": "Hello"
    }
    
    let msgContentEvent = TextMessageContentEvent(
      `type`: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Hello",
      rawEvent: some(msgContentRawEvent)
    )
    
    let invalidEvents1: seq[BaseEvent] = @[
      BaseEvent(startedEvent),
      BaseEvent(msgContentEvent)
    ]
    
    expect VerifyError:
      discard verifyEvents(invalidEvents1)
    
    # Test message without proper end
    let startedRawEvent2 = %*{
      "type": "RUN_STARTED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let startedEvent2 = RunStartedEvent(
      `type`: EventType.RUN_STARTED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(startedRawEvent2)
    )
    
    let msgStartRawEvent = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg1",
      "role": $RoleAssistant
    }
    
    let msgStartEvent = TextMessageStartEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: $RoleAssistant,
      rawEvent: some(msgStartRawEvent)
    )
    
    let finishedRawEvent = %*{
      "type": "RUN_FINISHED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let finishedEvent = RunFinishedEvent(
      `type`: EventType.RUN_FINISHED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(finishedRawEvent)
    )
    
    let invalidEvents2: seq[BaseEvent] = @[
      BaseEvent(startedEvent2),
      BaseEvent(msgStartEvent),
      BaseEvent(finishedEvent)
    ]
    
    expect VerifyError:
      discard verifyEvents(invalidEvents2)
  
  test "verifyEvents should check message ID consistency":
    let startedRawEvent = %*{
      "type": "RUN_STARTED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let startedEvent = RunStartedEvent(
      `type`: EventType.RUN_STARTED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(startedRawEvent)
    )
    
    let msgStartRawEvent = %*{
      "type": "TEXT_MESSAGE_START",
      "messageId": "msg1",
      "role": $RoleAssistant
    }
    
    let msgStartEvent = TextMessageStartEvent(
      `type`: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: $RoleAssistant,
      rawEvent: some(msgStartRawEvent)
    )
    
    let msgEndRawEvent = %*{
      "type": "TEXT_MESSAGE_END",
      "messageId": "msg2"  # Message ID mismatch
    }
    
    let msgEndEvent = TextMessageEndEvent(
      `type`: EventType.TEXT_MESSAGE_END,
      messageId: "msg2",  # Message ID mismatch
      rawEvent: some(msgEndRawEvent)
    )
    
    let invalidEvents: seq[BaseEvent] = @[
      BaseEvent(startedEvent),
      BaseEvent(msgStartEvent),
      BaseEvent(msgEndEvent)
    ]
    
    expect VerifyError:
      discard verifyEvents(invalidEvents)
  
  test "verifyEvents should handle steps properly":
    let startedRawEvent = %*{
      "type": "RUN_STARTED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let startedEvent = RunStartedEvent(
      `type`: EventType.RUN_STARTED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(startedRawEvent)
    )
    
    let stepStartRawEvent = %*{
      "type": "STEP_STARTED",
      "stepName": "step1"
    }
    
    let stepStartEvent = StepStartedEvent(
      `type`: EventType.STEP_STARTED,
      stepName: "step1",
      rawEvent: some(stepStartRawEvent)
    )
    
    let stepFinishRawEvent = %*{
      "type": "STEP_FINISHED",
      "stepName": "step1"
    }
    
    let stepFinishEvent = StepFinishedEvent(
      `type`: EventType.STEP_FINISHED,
      stepName: "step1",
      rawEvent: some(stepFinishRawEvent)
    )
    
    let finishedRawEvent = %*{
      "type": "RUN_FINISHED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let finishedEvent = RunFinishedEvent(
      `type`: EventType.RUN_FINISHED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(finishedRawEvent)
    )
    
    let validStepEvents: seq[BaseEvent] = @[
      BaseEvent(startedEvent),
      BaseEvent(stepStartEvent),
      BaseEvent(stepFinishEvent),
      BaseEvent(finishedEvent)
    ]
    
    let result = verifyEvents(validStepEvents)
    check(result.len == 4)
    
    let startedRawEvent2 = %*{
      "type": "RUN_STARTED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let startedEvent2 = RunStartedEvent(
      `type`: EventType.RUN_STARTED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(startedRawEvent2)
    )
    
    let stepStartRawEvent2 = %*{
      "type": "STEP_STARTED",
      "stepName": "step1"
    }
    
    let stepStartEvent2 = StepStartedEvent(
      `type`: EventType.STEP_STARTED,
      stepName: "step1",
      rawEvent: some(stepStartRawEvent2)
    )
    
    let finishedRawEvent2 = %*{
      "type": "RUN_FINISHED",
      "threadId": "thread1",
      "runId": "run1"
    }
    
    let finishedEvent2 = RunFinishedEvent(
      `type`: EventType.RUN_FINISHED,
      threadId: "thread1",
      runId: "run1",
      rawEvent: some(finishedRawEvent2)
    )
    
    let invalidStepEvents: seq[BaseEvent] = @[
      BaseEvent(startedEvent2),
      BaseEvent(stepStartEvent2),
      BaseEvent(finishedEvent2)  # Missing step finish
    ]
    
    expect VerifyError:
      discard verifyEvents(invalidStepEvents)

when isMainModule:
  testVerifyEvents()