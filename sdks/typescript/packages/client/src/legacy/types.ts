// Protocol Events
export const LegacyRuntimeEventTypes = {
  TextMessageStart: "TextMessageStart",
  TextMessageContent: "TextMessageContent",
  TextMessageEnd: "TextMessageEnd",
  ActionExecutionStart: "ActionExecutionStart",
  ActionExecutionArgs: "ActionExecutionArgs",
  ActionExecutionEnd: "ActionExecutionEnd",
  ActionExecutionResult: "ActionExecutionResult",
  AgentStateMessage: "AgentStateMessage",
  MetaEvent: "MetaEvent",
  RunStarted: "RunStarted",
  RunFinished: "RunFinished",
  RunError: "RunError",
  NodeStarted: "NodeStarted",
  NodeFinished: "NodeFinished",
} as const;

export const LegacyRuntimeMetaEventName = {
  LangGraphInterruptEvent: "LangGraphInterruptEvent",
  PredictState: "PredictState",
  Exit: "Exit",
} as const;

// Protocol Event type exports
export type RuntimeEventTypes =
  (typeof LegacyRuntimeEventTypes)[keyof typeof LegacyRuntimeEventTypes];
export type RuntimeMetaEventName =
  (typeof LegacyRuntimeMetaEventName)[keyof typeof LegacyRuntimeMetaEventName];

export interface LegacyTextMessageStart {
  type: "TextMessageStart";
  messageId: string;
  parentMessageId?: string;
  role?: string;
}

export interface LegacyTextMessageContent {
  type: "TextMessageContent";
  messageId: string;
  content: string;
}

export interface LegacyTextMessageEnd {
  type: "TextMessageEnd";
  messageId: string;
}

export interface LegacyActionExecutionStart {
  type: "ActionExecutionStart";
  actionExecutionId: string;
  actionName: string;
  parentMessageId?: string;
}

export interface LegacyActionExecutionArgs {
  type: "ActionExecutionArgs";
  actionExecutionId: string;
  args: string;
}

export interface LegacyActionExecutionEnd {
  type: "ActionExecutionEnd";
  actionExecutionId: string;
}

export interface LegacyActionExecutionResult {
  type: "ActionExecutionResult";
  actionName: string;
  actionExecutionId: string;
  result: string;
}

export interface LegacyAgentStateMessage {
  type: "AgentStateMessage";
  threadId: string;
  agentName: string;
  nodeName: string;
  runId: string;
  active: boolean;
  role: string;
  state: string;
  running: boolean;
}

export interface LegacyMetaEvent {
  type: "MetaEvent";
  name: RuntimeMetaEventName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the legacy meta payload is opaque
  value?: any;
}

export interface LegacyRunError {
  type: "RunError";
  message: string;
  code?: string;
}

export type LegacyRuntimeProtocolEvent =
  | LegacyTextMessageStart
  | LegacyTextMessageContent
  | LegacyTextMessageEnd
  | LegacyActionExecutionStart
  | LegacyActionExecutionArgs
  | LegacyActionExecutionEnd
  | LegacyActionExecutionResult
  | LegacyAgentStateMessage
  | LegacyMetaEvent
  | LegacyRunError;

// Message type exports. Undiscriminated: none of the three carries a `kind`
// tag, so narrowing the union goes by which field is present — `content` for a
// text message, `name` for an action execution, `result`/`actionExecutionId`
// for a result. `name`, not `arguments`: `arguments` is optional on an action
// execution, so its absence proves nothing, and a narrowing that tested it
// would misread every argument-less tool call as some other shape.
export interface LegacyTextMessage {
  id: string;
  role: string;
  content: string;
  parentMessageId?: string;
}

export interface LegacyActionExecutionMessage {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed tool arguments are arbitrary JSON
  arguments?: any;
  parentMessageId?: string;
}

export interface LegacyResultMessage {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are arbitrary JSON
  result?: any;
  actionExecutionId: string;
  actionName: string;
}

export type LegacyMessage = LegacyTextMessage | LegacyActionExecutionMessage | LegacyResultMessage;
