import json
import options
import ../../core/types

type
  LegacyRuntimeEventType* = enum
    TextMessageStart = "text_message_start"
    TextMessageContent = "text_message_content" 
    TextMessageEnd = "text_message_end"
    ActionExecutionStart = "action_execution_start"
    ActionExecutionArgs = "action_execution_args"
    ActionExecutionEnd = "action_execution_end"
    MetaEvent = "meta_event"
    
  LegacyRuntimeProtocolEvent* = object
    case eventType*: LegacyRuntimeEventType
    of TextMessageStart:
      textMessageStart*: LegacyTextMessageStart
    of TextMessageContent:
      textMessageContent*: LegacyTextMessageContent
    of TextMessageEnd:
      textMessageEnd*: LegacyTextMessageEnd
    of ActionExecutionStart:
      actionExecutionStart*: LegacyActionExecutionStart
    of ActionExecutionArgs:
      actionExecutionArgs*: LegacyActionExecutionArgs
    of ActionExecutionEnd:
      actionExecutionEnd*: LegacyActionExecutionEnd
    of MetaEvent:
      metaEvent*: LegacyMetaEvent
  
  LegacyMessageType* = enum
    Text = "text"
    ActionExecution = "action_execution"
    AgentState = "agent_state"
    Result = "result"
  
  LegacyBaseMessage* = object of RootObj
    threadId*: string
    runId*: string
    messageType*: LegacyMessageType
  
  LegacyTextMessage* = object of LegacyBaseMessage
    messageId*: string
    role*: string
    content*: string
  
  LegacyActionExecutionMessage* = object of LegacyBaseMessage
    actionId*: string
    action*: string
    args*: string
  
  LegacyAgentStateMessage* = object of LegacyBaseMessage
    state*: JsonNode
  
  LegacyResultMessage* = object of LegacyBaseMessage
    result*: JsonNode
  
  LegacyMessage* = ref object
    case messageType*: LegacyMessageType
    of Text:
      textMessage*: LegacyTextMessage
    of ActionExecution:
      actionMessage*: LegacyActionExecutionMessage
    of AgentState:
      stateMessage*: LegacyAgentStateMessage
    of Result:
      resultMessage*: LegacyResultMessage
  
  LegacyTextMessageStart* = object
    threadId*: string
    runId*: string
    messageId*: string
    role*: string
  
  LegacyTextMessageContent* = object
    threadId*: string
    runId*: string
    messageId*: string
    content*: string
  
  LegacyTextMessageEnd* = object
    threadId*: string
    runId*: string
    messageId*: string
  
  LegacyActionExecutionStart* = object
    threadId*: string
    runId*: string
    actionId*: string
    action*: string
  
  LegacyActionExecutionArgs* = object
    threadId*: string
    runId*: string
    actionId*: string
    args*: string
  
  LegacyActionExecutionEnd* = object
    threadId*: string
    runId*: string
    actionId*: string
  
  LegacyMetaEvent* = object
    threadId*: string
    runId*: string
    name*: string
    payload*: JsonNode

proc toJson*(event: LegacyTextMessageStart): JsonNode =
  result = %*{
    "type": $TextMessageStart,
    "threadId": event.threadId,
    "runId": event.runId,
    "messageId": event.messageId,
    "role": event.role
  }

proc toJson*(event: LegacyTextMessageContent): JsonNode =
  result = %*{
    "type": $TextMessageContent,
    "threadId": event.threadId,
    "runId": event.runId,
    "messageId": event.messageId,
    "content": event.content
  }

proc toJson*(event: LegacyTextMessageEnd): JsonNode =
  result = %*{
    "type": $TextMessageEnd,
    "threadId": event.threadId,
    "runId": event.runId,
    "messageId": event.messageId
  }

proc toJson*(event: LegacyActionExecutionStart): JsonNode =
  result = %*{
    "type": $ActionExecutionStart,
    "threadId": event.threadId,
    "runId": event.runId,
    "actionId": event.actionId,
    "action": event.action
  }

proc toJson*(event: LegacyActionExecutionArgs): JsonNode =
  result = %*{
    "type": $ActionExecutionArgs,
    "threadId": event.threadId,
    "runId": event.runId,
    "actionId": event.actionId, 
    "args": event.args
  }

proc toJson*(event: LegacyActionExecutionEnd): JsonNode =
  result = %*{
    "type": $ActionExecutionEnd,
    "threadId": event.threadId,
    "runId": event.runId,
    "actionId": event.actionId
  }

proc toJson*(event: LegacyMetaEvent): JsonNode =
  result = %*{
    "type": $MetaEvent,
    "threadId": event.threadId,
    "runId": event.runId,
    "name": event.name,
    "payload": event.payload
  }

proc toJson*(event: LegacyRuntimeProtocolEvent): JsonNode =
  case event.eventType
  of TextMessageStart:
    event.textMessageStart.toJson()
  of TextMessageContent:
    event.textMessageContent.toJson()
  of TextMessageEnd:
    event.textMessageEnd.toJson()
  of ActionExecutionStart:
    event.actionExecutionStart.toJson()
  of ActionExecutionArgs:
    event.actionExecutionArgs.toJson()
  of ActionExecutionEnd:
    event.actionExecutionEnd.toJson()
  of MetaEvent:
    event.metaEvent.toJson()