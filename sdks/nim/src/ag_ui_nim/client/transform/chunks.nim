import ../../core/events
import ../../core/types

type
  TextMessageFields = object
    messageId: string
  
  ToolCallFields = object
    toolCallId: string
    toolCallName: string
    parentMessageId: string
  
  ChunkTransformState = object
    textMessageFields: Option[TextMessageFields]
    toolCallFields: Option[ToolCallFields]
    mode: Option[string]  # "text" or "tool"
    debug: bool

proc closeTextMessage(state: var ChunkTransformState): TextMessageEndEvent =
  ## Close the active text message
  if state.mode.isNone or state.mode.get() != "text" or state.textMessageFields.isNone:
    raise newException(ValueError, "No text message to close")
  
  result = TextMessageEndEvent(
    messageId: state.textMessageFields.get().messageId
  )
  
  if state.debug:
    echo "[TRANSFORM]: TEXT_MESSAGE_END ", $result
  
  state.mode = none(string)
  state.textMessageFields = none(TextMessageFields)

proc closeToolCall(state: var ChunkTransformState): ToolCallEndEvent =
  ## Close the active tool call
  if state.mode.isNone or state.mode.get() != "tool" or state.toolCallFields.isNone:
    raise newException(ValueError, "No tool call to close")
  
  result = ToolCallEndEvent(
    toolCallId: state.toolCallFields.get().toolCallId
  )
  
  if state.debug:
    echo "[TRANSFORM]: TOOL_CALL_END ", $result
  
  state.mode = none(string)
  state.toolCallFields = none(ToolCallFields)

proc transformChunks*(events: seq[BaseEvent], debug: bool = false): seq[BaseEvent] =
  ## Transform chunk events into start/content/end events
  var state = ChunkTransformState(debug: debug)
  result = @[]
  
  for event in events:
    case event.type
    of EventType.TEXT_MESSAGE_CHUNK:
      let e = cast[TextMessageChunkEvent](event)
      
      # If we have an active tool call, close it
      if state.mode.isSome and state.mode.get() == "tool":
        result.add(closeToolCall(state))
      
      # If no active text message, start one
      if state.mode.isNone or state.mode.get() != "text":
        # Start a new text message
        let startEvent = TextMessageStartEvent(
          messageId: e.messageId,
          role: e.role
        )
        result.add(startEvent)
        
        state.mode = some("text")
        state.textMessageFields = some(TextMessageFields(
          messageId: e.messageId
        ))
        
        if state.debug:
          echo "[TRANSFORM]: TEXT_MESSAGE_START ", $startEvent
      
      # Add content event
      let contentEvent = TextMessageContentEvent(
        messageId: e.messageId,
        content: e.content
      )
      result.add(contentEvent)
      
      if state.debug:
        echo "[TRANSFORM]: TEXT_MESSAGE_CONTENT ", $contentEvent
    
    of EventType.TOOL_CALL_CHUNK:
      let e = cast[ToolCallChunkEvent](event)
      
      # If we have an active text message, close it
      if state.mode.isSome and state.mode.get() == "text":
        result.add(closeTextMessage(state))
      
      # If no active tool call, start one
      if state.mode.isNone or state.mode.get() != "tool":
        # Start a new tool call
        let startEvent = ToolCallStartEvent(
          toolCallId: e.toolCallId,
          toolCallName: e.toolCallName,
          parentMessageId: e.parentMessageId
        )
        result.add(startEvent)
        
        state.mode = some("tool")
        state.toolCallFields = some(ToolCallFields(
          toolCallId: e.toolCallId,
          toolCallName: e.toolCallName,
          parentMessageId: e.parentMessageId
        ))
        
        if state.debug:
          echo "[TRANSFORM]: TOOL_CALL_START ", $startEvent
      
      # Add args event
      let argsEvent = ToolCallArgsEvent(
        toolCallId: e.toolCallId,
        args: e.args
      )
      result.add(argsEvent)
      
      if state.debug:
        echo "[TRANSFORM]: TOOL_CALL_ARGS ", $argsEvent
    
    of EventType.RUN_FINISHED, EventType.RUN_ERROR:
      # Close any active events before ending the run
      if state.mode.isSome:
        if state.mode.get() == "text":
          result.add(closeTextMessage(state))
        elif state.mode.get() == "tool":
          result.add(closeToolCall(state))
      
      # Add the event
      result.add(event)
    
    else:
      # Pass through other events
      result.add(event)
  
  # Close any active events at the end of the stream
  if state.mode.isSome:
    if state.mode.get() == "text":
      result.add(closeTextMessage(state))
    elif state.mode.get() == "tool":
      result.add(closeToolCall(state))