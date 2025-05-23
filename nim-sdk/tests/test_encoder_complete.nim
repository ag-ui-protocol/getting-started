import unittest
import json
import options
import strutils
import ../src/ag_ui_nim/core/types
import ../src/ag_ui_nim/core/events
import ../src/ag_ui_nim/encoder/encoder

suite "Encoder 100% Coverage Tests":
  test "EventEncoder with protobuf accept":
    # Test with protobuf accept header
    let encoder = newEventEncoder("application/vnd.ag-ui.event+proto")
    check encoder.getContentType() == "text/event-stream"  # Currently returns SSE
    
  test "Encode all event types as SSE":
    let encoder = newEventEncoder()
    
    # TextMessageEndEvent
    let textEnd = newTextMessageEndEvent("msg1")
    let textEndSSE = encoder.encodeSSE(textEnd)
    check textEndSSE.contains("data: ")
    check textEndSSE.contains("TEXT_MESSAGE_END")
    check textEndSSE.endsWith("\n\n")
    
    # ToolCallStartEvent
    let toolStart = newToolCallStartEvent("call1", "func1", some("parent1"))
    let toolStartSSE = encoder.encodeSSE(toolStart)
    check toolStartSSE.contains("data: ")
    check toolStartSSE.contains("TOOL_CALL_START")
    
    # ToolCallArgsEvent
    let toolArgs = newToolCallArgsEvent("call1", "args delta")
    let toolArgsSSE = encoder.encodeSSE(toolArgs)
    check toolArgsSSE.contains("data: ")
    check toolArgsSSE.contains("TOOL_CALL_ARGS")
    
    # ToolCallEndEvent
    let toolEnd = newToolCallEndEvent("call1")
    let toolEndSSE = encoder.encodeSSE(toolEnd)
    check toolEndSSE.contains("data: ")
    check toolEndSSE.contains("TOOL_CALL_END")
    
    # StateSnapshotEvent
    let stateSnapshot = newStateSnapshotEvent(%*{"state": "data"})
    let stateSnapshotSSE = encoder.encodeSSE(stateSnapshot)
    check stateSnapshotSSE.contains("data: ")
    check stateSnapshotSSE.contains("STATE_SNAPSHOT")
    
    # StateDeltaEvent
    let stateDelta = newStateDeltaEvent(@[%*{"op": "add", "path": "/foo", "value": "bar"}])
    let stateDeltaSSE = encoder.encodeSSE(stateDelta)
    check stateDeltaSSE.contains("data: ")
    check stateDeltaSSE.contains("STATE_DELTA")
    
    # RawEvent
    let rawEvent = newRawEvent(%*{"event": "data"}, some("source1"))
    let rawEventSSE = encoder.encodeSSE(rawEvent)
    check rawEventSSE.contains("data: ")
    check rawEventSSE.contains("RAW")
    
    # CustomEvent
    let customEvent = newCustomEvent("myEvent", %*{"value": 123})
    let customEventSSE = encoder.encodeSSE(customEvent)
    check customEventSSE.contains("data: ")
    check customEventSSE.contains("CUSTOM")
    
    # RunStartedEvent
    let runStarted = newRunStartedEvent("thread1", "run1")
    let runStartedSSE = encoder.encodeSSE(runStarted)
    check runStartedSSE.contains("data: ")
    check runStartedSSE.contains("RUN_STARTED")
    
    # RunFinishedEvent
    let runFinished = newRunFinishedEvent("thread1", "run1")
    let runFinishedSSE = encoder.encodeSSE(runFinished)
    check runFinishedSSE.contains("data: ")
    check runFinishedSSE.contains("RUN_FINISHED")
    
    # StepStartedEvent
    let stepStarted = newStepStartedEvent("step1")
    let stepStartedSSE = encoder.encodeSSE(stepStarted)
    check stepStartedSSE.contains("data: ")
    check stepStartedSSE.contains("STEP_STARTED")
    
    # StepFinishedEvent
    let stepFinished = newStepFinishedEvent("step1")
    let stepFinishedSSE = encoder.encodeSSE(stepFinished)
    check stepFinishedSSE.contains("data: ")
    check stepFinishedSSE.contains("STEP_FINISHED")
    
    # TextMessageChunkEvent
    let textChunk = newTextMessageChunkEvent("msg1", "assistant", "chunk content")
    let textChunkSSE = encoder.encodeSSE(textChunk)
    check textChunkSSE.contains("data: ")
    check textChunkSSE.contains("TEXT_MESSAGE_CHUNK")
    
    # ToolCallChunkEvent
    let toolChunk = newToolCallChunkEvent("call1", "function1", "parentMsg1", "{\"arg\": \"value\"}")
    let toolChunkSSE = encoder.encodeSSE(toolChunk)
    check toolChunkSSE.contains("data: ")
    check toolChunkSSE.contains("TOOL_CALL_CHUNK")
    
  test "Encode Event union with all kinds":
    let encoder = newEventEncoder()
    var event: Event
    var sse: string
    
    # TextMessageContent
    event = Event(kind: EkTextMessageContent, 
                  textMessageContent: newTextMessageContentEvent("msg1", "content"))
    sse = encoder.encodeSSE(event)
    check sse.contains("TEXT_MESSAGE_CONTENT")
    
    # TextMessageEnd
    event = Event(kind: EkTextMessageEnd,
                  textMessageEnd: newTextMessageEndEvent("msg1"))
    sse = encoder.encodeSSE(event)
    check sse.contains("TEXT_MESSAGE_END")
    
    # TextMessageChunk
    event = Event(kind: EkTextMessageChunk,
                  textMessageChunk: newTextMessageChunkEvent("msg1", "assistant", "chunk"))
    sse = encoder.encodeSSE(event)
    check sse.contains("TEXT_MESSAGE_CHUNK")
    
    # ToolCallStart
    event = Event(kind: EkToolCallStart,
                  toolCallStart: newToolCallStartEvent("call1", "func1"))
    sse = encoder.encodeSSE(event)
    check sse.contains("TOOL_CALL_START")
    
    # ToolCallArgs
    event = Event(kind: EkToolCallArgs,
                  toolCallArgs: newToolCallArgsEvent("call1", "args"))
    sse = encoder.encodeSSE(event)
    check sse.contains("TOOL_CALL_ARGS")
    
    # ToolCallEnd
    event = Event(kind: EkToolCallEnd,
                  toolCallEnd: newToolCallEndEvent("call1"))
    sse = encoder.encodeSSE(event)
    check sse.contains("TOOL_CALL_END")
    
    # ToolCallChunk
    event = Event(kind: EkToolCallChunk,
                  toolCallChunk: newToolCallChunkEvent("call1", "func1", "parent1", "args"))
    sse = encoder.encodeSSE(event)
    check sse.contains("TOOL_CALL_CHUNK")
    
    # StateSnapshot
    event = Event(kind: EkStateSnapshot,
                  stateSnapshot: newStateSnapshotEvent(%*{"state": "data"}))
    sse = encoder.encodeSSE(event)
    check sse.contains("STATE_SNAPSHOT")
    
    # StateDelta
    event = Event(kind: EkStateDelta,
                  stateDelta: newStateDeltaEvent(@[%*{"op": "add"}]))
    sse = encoder.encodeSSE(event)
    check sse.contains("STATE_DELTA")
    
    # MessagesSnapshot
    let msg = Message(kind: MkUser, user: newUserMessage("u1", "content"))
    event = Event(kind: EkMessagesSnapshot,
                  messagesSnapshot: newMessagesSnapshotEvent(@[msg]))
    sse = encoder.encodeSSE(event)
    check sse.contains("MESSAGES_SNAPSHOT")
    
    # Raw
    event = Event(kind: EkRaw,
                  raw: newRawEvent(%*{"event": "data"}))
    sse = encoder.encodeSSE(event)
    check sse.contains("RAW")
    
    # Custom
    event = Event(kind: EkCustom,
                  custom: newCustomEvent("custom1", %*{"val": 1}))
    sse = encoder.encodeSSE(event)
    check sse.contains("CUSTOM")
    
    # RunStarted
    event = Event(kind: EkRunStarted,
                  runStarted: newRunStartedEvent("thread1", "run1"))
    sse = encoder.encodeSSE(event)
    check sse.contains("RUN_STARTED")
    
    # RunFinished
    event = Event(kind: EkRunFinished,
                  runFinished: newRunFinishedEvent("thread1", "run1"))
    sse = encoder.encodeSSE(event)
    check sse.contains("RUN_FINISHED")
    
    # RunError
    event = Event(kind: EkRunError,
                  runError: newRunErrorEvent("Error message", some("ERR_CODE")))
    sse = encoder.encodeSSE(event)
    check sse.contains("RUN_ERROR")
    
    # StepStarted
    event = Event(kind: EkStepStarted,
                  stepStarted: newStepStartedEvent("step1"))
    sse = encoder.encodeSSE(event)
    check sse.contains("STEP_STARTED")
    
    # StepFinished
    event = Event(kind: EkStepFinished,
                  stepFinished: newStepFinishedEvent("step1"))
    sse = encoder.encodeSSE(event)
    check sse.contains("STEP_FINISHED")
    
  test "Encode method with Event":
    let encoder = newEventEncoder()
    
    # Test encode method with Event
    let event = Event(kind: EkTextMessageStart,
                      textMessageStart: newTextMessageStartEvent("msg1", "assistant"))
    let encoded = encoder.encode(event)
    check encoded.contains("TEXT_MESSAGE_START")
    check encoded.contains("data: ")
    check encoded.endsWith("\n\n")