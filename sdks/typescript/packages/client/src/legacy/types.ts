import { z } from "zod/v4";

// Protocol Events
export const LegacyRuntimeEventTypes = z.enum([
  "TextMessageStart",
  "TextMessageContent",
  "TextMessageEnd",
  "ActionExecutionStart",
  "ActionExecutionArgs",
  "ActionExecutionEnd",
  "ActionExecutionResult",
  "AgentStateMessage",
  "MetaEvent",
  "RunStarted",
  "RunFinished",
  "RunError",
  "NodeStarted",
  "NodeFinished",
]);

export const LegacyRuntimeMetaEventName = z.enum([
  "LangGraphInterruptEvent",
  "PredictState",
  "Exit",
]);

export const LegacyTextMessageStart = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.TextMessageStart),
  messageId: z.string(),
  parentMessageId: z.string().optional(),
  role: z.string().optional(),
});

export const LegacyTextMessageContent = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.TextMessageContent),
  messageId: z.string(),
  content: z.string(),
});

export const LegacyTextMessageEnd = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.TextMessageEnd),
  messageId: z.string(),
});

export const LegacyActionExecutionStart = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.ActionExecutionStart),
  actionExecutionId: z.string(),
  actionName: z.string(),
  parentMessageId: z.string().optional(),
});

export const LegacyActionExecutionArgs = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.ActionExecutionArgs),
  actionExecutionId: z.string(),
  args: z.string(),
});

export const LegacyActionExecutionEnd = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.ActionExecutionEnd),
  actionExecutionId: z.string(),
});

export const LegacyActionExecutionResult = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.ActionExecutionResult),
  actionName: z.string(),
  actionExecutionId: z.string(),
  result: z.string(),
});

export const LegacyAgentStateMessage = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.AgentStateMessage),
  threadId: z.string(),
  agentName: z.string(),
  nodeName: z.string(),
  runId: z.string(),
  active: z.boolean(),
  role: z.string(),
  state: z.string(),
  running: z.boolean(),
});

export const LegacyMetaEvent = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.MetaEvent),
  name: LegacyRuntimeMetaEventName,
  value: z.any(),
});


export const LegacyRunError = z.object({
  type: z.literal(LegacyRuntimeEventTypes.enum.RunError),
  message: z.string(),
  code: z.string().optional(),
});

export const LegacyRuntimeProtocolEvent = z.discriminatedUnion("type", [
  LegacyTextMessageStart,
  LegacyTextMessageContent,
  LegacyTextMessageEnd,
  LegacyActionExecutionStart,
  LegacyActionExecutionArgs,
  LegacyActionExecutionEnd,
  LegacyActionExecutionResult,
  LegacyAgentStateMessage,
  LegacyMetaEvent,
  LegacyRunError,
]);

// Protocol Event type exports
export type RuntimeEventTypes = z.infer<typeof LegacyRuntimeEventTypes>;
export type RuntimeMetaEventName = z.infer<typeof LegacyRuntimeMetaEventName>;
export type LegacyTextMessageStart = z.infer<typeof LegacyTextMessageStart>;
export type LegacyTextMessageContent = z.infer<typeof LegacyTextMessageContent>;
export type LegacyTextMessageEnd = z.infer<typeof LegacyTextMessageEnd>;
export type LegacyActionExecutionStart = z.infer<typeof LegacyActionExecutionStart>;
export type LegacyActionExecutionArgs = z.infer<typeof LegacyActionExecutionArgs>;
export type LegacyActionExecutionEnd = z.infer<typeof LegacyActionExecutionEnd>;
export type LegacyActionExecutionResult = z.infer<typeof LegacyActionExecutionResult>;
export type LegacyAgentStateMessage = z.infer<typeof LegacyAgentStateMessage>;
export type LegacyMetaEvent = z.infer<typeof LegacyMetaEvent>;
export type LegacyRuntimeProtocolEvent = z.infer<typeof LegacyRuntimeProtocolEvent>;
export type LegacyRunError = z.infer<typeof LegacyRunError>;

// Message schemas (with kind discriminator)
export const LegacyTextMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  parentMessageId: z.string().optional(),
});

export const LegacyActionExecutionMessageSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.any(),
  parentMessageId: z.string().optional(),
});

export const LegacyResultMessageSchema = z.object({
  id: z.string(),
  result: z.any(),
  actionExecutionId: z.string(),
  actionName: z.string(),
});

// Message type exports
export type LegacyTextMessage = z.infer<typeof LegacyTextMessageSchema>;
export type LegacyActionExecutionMessage = z.infer<typeof LegacyActionExecutionMessageSchema>;
export type LegacyResultMessage = z.infer<typeof LegacyResultMessageSchema>;
export type LegacyMessage = LegacyTextMessage | LegacyActionExecutionMessage | LegacyResultMessage;
