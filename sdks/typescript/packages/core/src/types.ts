// Canonical TypeScript types for AG-UI messages, tools, run input, and core
// supporting types. This is the authoritative type surface of @ag-ui/core.

export interface FunctionCall {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
  encryptedValue?: string;
}

export interface TextInputContent {
  type: "text";
  text: string;
}

export interface InputContentDataSource {
  type: "data";
  value: string;
  mimeType: string;
}

export interface InputContentUrlSource {
  type: "url";
  value: string;
  mimeType?: string;
}

export type InputContentSource = InputContentDataSource | InputContentUrlSource;

export interface ImageInputContent {
  type: "image";
  source: InputContentSource;
  metadata?: unknown;
}

export interface AudioInputContent {
  type: "audio";
  source: InputContentSource;
  metadata?: unknown;
}

export interface VideoInputContent {
  type: "video";
  source: InputContentSource;
  metadata?: unknown;
}

export interface DocumentInputContent {
  type: "document";
  source: InputContentSource;
  metadata?: unknown;
}

export type ImageInputPart = ImageInputContent;
export type AudioInputPart = AudioInputContent;
export type VideoInputPart = VideoInputContent;
export type DocumentInputPart = DocumentInputContent;

export interface BinaryInputContent {
  type: "binary";
  mimeType: string;
  id?: string;
  url?: string;
  data?: string;
  filename?: string;
}

export type InputContent =
  | TextInputContent
  | ImageInputContent
  | AudioInputContent
  | VideoInputContent
  | DocumentInputContent
  | BinaryInputContent;

export type InputContentPart = InputContent;

interface BaseMessageFields {
  id: string;
  name?: string;
  encryptedValue?: string;
}

export interface DeveloperMessage extends BaseMessageFields {
  role: "developer";
  content: string;
}

export interface SystemMessage extends BaseMessageFields {
  role: "system";
  content: string;
}

export interface AssistantMessage extends BaseMessageFields {
  role: "assistant";
  content?: string;
  toolCalls?: ToolCall[];
}

export interface UserMessage extends BaseMessageFields {
  role: "user";
  content: string | InputContent[];
}

export interface ToolMessage {
  id: string;
  content: string;
  role: "tool";
  toolCallId: string;
  error?: string;
  encryptedValue?: string;
}

export interface ActivityMessage {
  id: string;
  role: "activity";
  activityType: string;
  content: Record<string, any>;
}

export interface ReasoningMessage {
  id: string;
  role: "reasoning";
  content: string;
  encryptedValue?: string;
}

export type Message =
  | DeveloperMessage
  | SystemMessage
  | AssistantMessage
  | UserMessage
  | ToolMessage
  | ActivityMessage
  | ReasoningMessage;

export type Role =
  | "developer"
  | "system"
  | "assistant"
  | "user"
  | "tool"
  | "activity"
  | "reasoning";

export interface Context {
  description: string;
  value: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters?: any;
  metadata?: Record<string, any>;
}

export interface Interrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, any>;
  expiresAt?: string;
  metadata?: Record<string, any>;
}

export type ResumeStatus = "resolved" | "cancelled";

export interface ResumeEntry {
  interruptId: string;
  status: ResumeStatus;
  payload?: any;
}

export interface RunAgentInput {
  threadId: string;
  runId: string;
  parentRunId?: string;
  state?: any;
  messages: Message[];
  tools: Tool[];
  context: Context[];
  forwardedProps?: any;
  resume?: ResumeEntry[];
}

export type State = any;

export class AGUIError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AGUIConnectNotImplementedError extends AGUIError {
  constructor() {
    super("Connect not implemented. This method is not supported by the current agent.");
  }
}
