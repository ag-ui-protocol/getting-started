import unittest
import json
import options
import ../src/ag_ui_nim/core/types
import ../src/ag_ui_nim/core/events

suite "Events 100% Coverage Tests":
  test "All EventType enum values":
    # Test all event type enum values
    check $TEXT_MESSAGE_START == "TEXT_MESSAGE_START"
    check $TEXT_MESSAGE_CONTENT == "TEXT_MESSAGE_CONTENT"
    check $TEXT_MESSAGE_END == "TEXT_MESSAGE_END"
    check $TEXT_MESSAGE_CHUNK == "TEXT_MESSAGE_CHUNK"
    check $TOOL_CALL_START == "TOOL_CALL_START"
    check $TOOL_CALL_ARGS == "TOOL_CALL_ARGS"
    check $TOOL_CALL_END == "TOOL_CALL_END"
    check $TOOL_CALL_CHUNK == "TOOL_CALL_CHUNK"
    check $STATE_SNAPSHOT == "STATE_SNAPSHOT"
    check $STATE_DELTA == "STATE_DELTA"
    check $MESSAGES_SNAPSHOT == "MESSAGES_SNAPSHOT"
    check $RAW == "RAW"
    check $CUSTOM == "CUSTOM"
    check $RUN_STARTED == "RUN_STARTED"
    check $RUN_FINISHED == "RUN_FINISHED"
    check $RUN_ERROR == "RUN_ERROR"
    check $STEP_STARTED == "STEP_STARTED"
    check $STEP_FINISHED == "STEP_FINISHED"
    
  test "Create all event types":
    # ToolCallArgsEvent
    let toolCallArgs = newToolCallArgsEvent("call1", "args delta", some(int64(12345)), some(%*{"raw": "data"}))
    check toolCallArgs.`type` == TOOL_CALL_ARGS
    check toolCallArgs.toolCallId == "call1"
    check toolCallArgs.delta == "args delta"
    check toolCallArgs.timestamp.get == int64(12345)
    check toolCallArgs.rawEvent.get["raw"].getStr == "data"
    
    # ToolCallEndEvent
    let toolCallEnd = newToolCallEndEvent("call1", some(int64(12346)), some(%*{"raw": "end"}))
    check toolCallEnd.`type` == TOOL_CALL_END
    check toolCallEnd.toolCallId == "call1"
    check toolCallEnd.timestamp.get == int64(12346)
    
    # RawEvent
    let rawEvent = newRawEvent(%*{"event": "data"}, some("source1"), some(int64(12347)), some(%*{"meta": "data"}))
    check rawEvent.`type` == RAW
    check rawEvent.event["event"].getStr == "data"
    check rawEvent.source.get == "source1"
    
    # CustomEvent
    let customEvent = newCustomEvent("myEvent", %*{"value": 123}, some(int64(12348)), some(%*{"custom": "raw"}))
    check customEvent.`type` == CUSTOM
    check customEvent.name == "myEvent"
    check customEvent.value["value"].getInt == 123
    
    # RunStartedEvent
    let runStarted = newRunStartedEvent("thread1", "run1", some(int64(12349)), some(%*{"start": "data"}))
    check runStarted.`type` == RUN_STARTED
    check runStarted.threadId == "thread1"
    check runStarted.runId == "run1"
    
    # RunFinishedEvent
    let runFinished = newRunFinishedEvent("thread1", "run1", some(int64(12350)), some(%*{"finish": "data"}))
    check runFinished.`type` == RUN_FINISHED
    check runFinished.threadId == "thread1"
    check runFinished.runId == "run1"
    
    # StepStartedEvent
    let stepStarted = newStepStartedEvent("step1", some(int64(12351)), some(%*{"step": "start"}))
    check stepStarted.`type` == STEP_STARTED
    check stepStarted.stepName == "step1"
    
    # StepFinishedEvent
    let stepFinished = newStepFinishedEvent("step1", some(int64(12352)), some(%*{"step": "finish"}))
    check stepFinished.`type` == STEP_FINISHED
    check stepFinished.stepName == "step1"
    
    # TextMessageChunkEvent
    let textChunk = newTextMessageChunkEvent("msg1", "assistant", "chunk content", some(int64(12353)), some(%*{"chunk": "data"}))
    check textChunk.`type` == TEXT_MESSAGE_CHUNK
    check textChunk.messageId == "msg1"
    check textChunk.role == "assistant"
    check textChunk.content == "chunk content"
    
    # ToolCallChunkEvent
    let toolChunk = newToolCallChunkEvent("call1", "function1", "parentMsg1", "{\"arg\": \"value\"}", 
                                           some(int64(12354)), some(%*{"chunk": "tool"}))
    check toolChunk.`type` == TOOL_CALL_CHUNK
    check toolChunk.toolCallId == "call1"
    check toolChunk.toolCallName == "function1"
    check toolChunk.args == "{\"arg\": \"value\"}"
    check toolChunk.parentMessageId.get == "parentMsg1"
    
  test "Event union type with all kinds":
    # Test all event kinds in the union type
    var event: Event
    
    # TextMessageContent
    event = Event(kind: EkTextMessageContent, 
                  textMessageContent: newTextMessageContentEvent("msg1", "content"))
    check event.kind == EkTextMessageContent
    check event.textMessageContent.messageId == "msg1"
    
    # TextMessageEnd
    event = Event(kind: EkTextMessageEnd,
                  textMessageEnd: newTextMessageEndEvent("msg1"))
    check event.kind == EkTextMessageEnd
    check event.textMessageEnd.messageId == "msg1"
    
    # TextMessageChunk
    event = Event(kind: EkTextMessageChunk,
                  textMessageChunk: newTextMessageChunkEvent("msg1", "assistant", "chunk"))
    check event.kind == EkTextMessageChunk
    check event.textMessageChunk.messageId == "msg1"
    
    # ToolCallStart
    event = Event(kind: EkToolCallStart,
                  toolCallStart: newToolCallStartEvent("call1", "func1"))
    check event.kind == EkToolCallStart
    check event.toolCallStart.toolCallId == "call1"
    
    # ToolCallArgs
    event = Event(kind: EkToolCallArgs,
                  toolCallArgs: newToolCallArgsEvent("call1", "args"))
    check event.kind == EkToolCallArgs
    check event.toolCallArgs.toolCallId == "call1"
    
    # ToolCallEnd
    event = Event(kind: EkToolCallEnd,
                  toolCallEnd: newToolCallEndEvent("call1"))
    check event.kind == EkToolCallEnd
    check event.toolCallEnd.toolCallId == "call1"
    
    # ToolCallChunk
    event = Event(kind: EkToolCallChunk,
                  toolCallChunk: newToolCallChunkEvent("call1", "func1", "parent1", "args"))
    check event.kind == EkToolCallChunk
    check event.toolCallChunk.toolCallId == "call1"
    
    # StateSnapshot
    event = Event(kind: EkStateSnapshot,
                  stateSnapshot: newStateSnapshotEvent(%*{"state": "data"}))
    check event.kind == EkStateSnapshot
    check event.stateSnapshot.snapshot["state"].getStr == "data"
    
    # StateDelta
    event = Event(kind: EkStateDelta,
                  stateDelta: newStateDeltaEvent(@[%*{"op": "add"}]))
    check event.kind == EkStateDelta
    check event.stateDelta.delta.len == 1
    
    # MessagesSnapshot
    let msg = Message(kind: MkUser, user: newUserMessage("u1", "content"))
    event = Event(kind: EkMessagesSnapshot,
                  messagesSnapshot: newMessagesSnapshotEvent(@[msg]))
    check event.kind == EkMessagesSnapshot
    check event.messagesSnapshot.messages.len == 1
    
    # Raw
    event = Event(kind: EkRaw,
                  raw: newRawEvent(%*{"event": "data"}))
    check event.kind == EkRaw
    check event.raw.event["event"].getStr == "data"
    
    # Custom
    event = Event(kind: EkCustom,
                  custom: newCustomEvent("custom1", %*{"val": 1}))
    check event.kind == EkCustom
    check event.custom.name == "custom1"
    
    # RunStarted
    event = Event(kind: EkRunStarted,
                  runStarted: newRunStartedEvent("thread1", "run1"))
    check event.kind == EkRunStarted
    check event.runStarted.threadId == "thread1"
    
    # RunFinished
    event = Event(kind: EkRunFinished,
                  runFinished: newRunFinishedEvent("thread1", "run1"))
    check event.kind == EkRunFinished
    check event.runFinished.threadId == "thread1"
    
    # RunError
    event = Event(kind: EkRunError,
                  runError: newRunErrorEvent("Error message", some("ERR_CODE")))
    check event.kind == EkRunError
    check event.runError.message == "Error message"
    
    # StepStarted
    event = Event(kind: EkStepStarted,
                  stepStarted: newStepStartedEvent("step1"))
    check event.kind == EkStepStarted
    check event.stepStarted.stepName == "step1"
    
    # StepFinished
    event = Event(kind: EkStepFinished,
                  stepFinished: newStepFinishedEvent("step1"))
    check event.kind == EkStepFinished
    check event.stepFinished.stepName == "step1"
    
  test "Events toJson for all types":
    # Test toJson for all event types
    let toolCallArgs = newToolCallArgsEvent("call1", "args delta")
    let toolCallArgsJson = toolCallArgs.toJson()
    check toolCallArgsJson["type"].getStr == "TOOL_CALL_ARGS"
    check toolCallArgsJson["toolCallId"].getStr == "call1"
    check toolCallArgsJson["delta"].getStr == "args delta"
    
    let toolCallEnd = newToolCallEndEvent("call1")
    let toolCallEndJson = toolCallEnd.toJson()
    check toolCallEndJson["type"].getStr == "TOOL_CALL_END"
    check toolCallEndJson["toolCallId"].getStr == "call1"
    
    let rawEvent = newRawEvent(%*{"event": "data"}, some("source1"))
    let rawEventJson = rawEvent.toJson()
    check rawEventJson["type"].getStr == "RAW"
    check rawEventJson["event"]["event"].getStr == "data"
    check rawEventJson["source"].getStr == "source1"
    
    let customEvent = newCustomEvent("myEvent", %*{"value": 123})
    let customEventJson = customEvent.toJson()
    check customEventJson["type"].getStr == "CUSTOM"
    check customEventJson["name"].getStr == "myEvent"
    check customEventJson["value"]["value"].getInt == 123
    
    let runStarted = newRunStartedEvent("thread1", "run1")
    let runStartedJson = runStarted.toJson()
    check runStartedJson["type"].getStr == "RUN_STARTED"
    check runStartedJson["threadId"].getStr == "thread1"
    check runStartedJson["runId"].getStr == "run1"
    
    let runFinished = newRunFinishedEvent("thread1", "run1")
    let runFinishedJson = runFinished.toJson()
    check runFinishedJson["type"].getStr == "RUN_FINISHED"
    check runFinishedJson["threadId"].getStr == "thread1"
    check runFinishedJson["runId"].getStr == "run1"
    
    let stepStarted = newStepStartedEvent("step1")
    let stepStartedJson = stepStarted.toJson()
    check stepStartedJson["type"].getStr == "STEP_STARTED"
    check stepStartedJson["stepName"].getStr == "step1"
    
    let stepFinished = newStepFinishedEvent("step1")
    let stepFinishedJson = stepFinished.toJson()
    check stepFinishedJson["type"].getStr == "STEP_FINISHED"
    check stepFinishedJson["stepName"].getStr == "step1"
    
    let textChunk = newTextMessageChunkEvent("msg1", "assistant", "chunk content")
    let textChunkJson = textChunk.toJson()
    check textChunkJson["type"].getStr == "TEXT_MESSAGE_CHUNK"
    check textChunkJson["messageId"].getStr == "msg1"
    check textChunkJson["role"].getStr == "assistant"
    check textChunkJson["content"].getStr == "chunk content"
    
    let toolChunk = newToolCallChunkEvent("call1", "function1", "parentMsg1", "{\"arg\": \"value\"}")
    let toolChunkJson = toolChunk.toJson()
    check toolChunkJson["type"].getStr == "TOOL_CALL_CHUNK"
    check toolChunkJson["toolCallId"].getStr == "call1"
    check toolChunkJson["toolCallName"].getStr == "function1"
    check toolChunkJson["args"].getStr == "{\"arg\": \"value\"}"
    check toolChunkJson["parentMessageId"].getStr == "parentMsg1"
    
  test "Event union toJson for all kinds":
    # Test Event union toJson for all kinds
    var event: Event
    var eventJson: JsonNode
    
    # TextMessageContent
    event = Event(kind: EkTextMessageContent, 
                  textMessageContent: newTextMessageContentEvent("msg1", "content"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "TEXT_MESSAGE_CONTENT"
    
    # TextMessageEnd
    event = Event(kind: EkTextMessageEnd,
                  textMessageEnd: newTextMessageEndEvent("msg1"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "TEXT_MESSAGE_END"
    
    # All other event kinds...
    event = Event(kind: EkTextMessageChunk,
                  textMessageChunk: newTextMessageChunkEvent("msg1", "assistant", "chunk"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "TEXT_MESSAGE_CHUNK"
    
    event = Event(kind: EkToolCallStart,
                  toolCallStart: newToolCallStartEvent("call1", "func1"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "TOOL_CALL_START"
    
    event = Event(kind: EkToolCallArgs,
                  toolCallArgs: newToolCallArgsEvent("call1", "args"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "TOOL_CALL_ARGS"
    
    event = Event(kind: EkToolCallEnd,
                  toolCallEnd: newToolCallEndEvent("call1"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "TOOL_CALL_END"
    
    event = Event(kind: EkToolCallChunk,
                  toolCallChunk: newToolCallChunkEvent("call1", "func1", "parent1", "args"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "TOOL_CALL_CHUNK"
    
    event = Event(kind: EkStateSnapshot,
                  stateSnapshot: newStateSnapshotEvent(%*{"state": "data"}))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "STATE_SNAPSHOT"
    
    event = Event(kind: EkStateDelta,
                  stateDelta: newStateDeltaEvent(@[%*{"op": "add"}]))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "STATE_DELTA"
    
    event = Event(kind: EkRaw,
                  raw: newRawEvent(%*{"event": "data"}))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "RAW"
    
    event = Event(kind: EkCustom,
                  custom: newCustomEvent("custom1", %*{"val": 1}))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "CUSTOM"
    
    event = Event(kind: EkRunStarted,
                  runStarted: newRunStartedEvent("thread1", "run1"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "RUN_STARTED"
    
    event = Event(kind: EkRunFinished,
                  runFinished: newRunFinishedEvent("thread1", "run1"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "RUN_FINISHED"
    
    event = Event(kind: EkRunError,
                  runError: newRunErrorEvent("Error message", some("ERR_CODE")))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "RUN_ERROR"
    
    event = Event(kind: EkStepStarted,
                  stepStarted: newStepStartedEvent("step1"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "STEP_STARTED"
    
    event = Event(kind: EkStepFinished,
                  stepFinished: newStepFinishedEvent("step1"))
    eventJson = event.toJson()
    check eventJson["type"].getStr == "STEP_FINISHED"