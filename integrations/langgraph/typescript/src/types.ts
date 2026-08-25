import {
  AssistantGraph,
  Message as LangGraphMessage,
} from "@langchain/langgraph-sdk";
import { MessageType } from "@langchain/core/messages";
import { RunAgentInput, TokenUsage } from "@ag-ui/core";

export enum LangGraphEventTypes {
  OnChainStart = "on_chain_start",
  OnChainStream = "on_chain_stream",
  OnChainEnd = "on_chain_end",
  OnChatModelStart = "on_chat_model_start",
  OnChatModelStream = "on_chat_model_stream",
  OnChatModelEnd = "on_chat_model_end",
  OnToolStart = "on_tool_start",
  OnToolEnd = "on_tool_end",
  OnToolError = "on_tool_error",
  OnCustomEvent = "on_custom_event",
  OnInterrupt = "on_interrupt",
}

export type LangGraphToolWithName = {
  type: "function";
  name?: string;
  function: {
    name: string;
    description: string;
    parameters: any;
  };
};

export type State<TDefinedState = Record<string, any>> = {
  [k in keyof TDefinedState]: TDefinedState[k] | null;
} & Record<string, any>;
export interface StateEnrichment {
  messages: LangGraphMessage[];
  tools: LangGraphToolWithName[];
  "ag-ui": {
    tools: LangGraphToolWithName[];
    context: RunAgentInput['context'];
    // A2UI tool-injection flag forwarded by the A2UI middleware
    // (forwardedProps.injectA2UITool). Present only when the middleware sets it.
    inject_a2ui_tool?: boolean | string;
  };
}

export type SchemaKeys = {
  input: string[] | null;
  output: string[] | null;
  context: string[] | null;
  config: string[] | null;
} | null;

export type MessageInProgress = {
  id: string;
  toolCallId?: string | null;
  toolCallName?: string | null;
};

export type ReasoningInProgress = {
  index: number;
  type?: LangGraphReasoning["type"];
  messageId: string;
  signature?: string;
};

export interface RunMetadata {
  id: string;
  schemaKeys?: SchemaKeys;
  nodeName?: string;
  prevNodeName?: string | null;
  exitingNode?: boolean;
  manuallyEmittedState?: State | null;
  threadId?: string;
  graphInfo?: AssistantGraph;
  hasFunctionStreaming?: boolean;
  // True once the platform-assigned run id is known (set from stream metadata)
  serverRunIdKnown?: boolean;
  // Per-LLM-call token usage accumulated across the run from provider-reported
  // numeric metadata; aggregated per (provider, model) and attached to the
  // terminal RUN_FINISHED event. Never holds prompt/completion content.
  usage?: TokenUsage[];
  // Set true when a tool call matching a predict_state entry is detected in
  // the chat model stream. Remains true through tool arg streaming and tool
  // execution; cleared in OnToolEnd/OnToolError. While set, STATE_SNAPSHOT
  // emission is suppressed so optimistic UI state is not overwritten.
  modelMadeToolCall?: boolean;
  // Pinned text message id for the current node. Set on the first
  // auto-streamed text chunk emitted from a node (from the chunk's id) and
  // reused for every subsequent TEXT_MESSAGE_START emitted from the same
  // node, so text resuming after a tool call (or after a fresh model
  // invocation within the same node) stays in the same UI bubble. Cleared
  // by handleNodeChange on every node transition, so multi-node graphs
  // (e.g. supervisor routing to specialist agents) preserve separate
  // bubbles per node. Reset implicitly on the next run when activeRun is
  // replaced. Not used by ManuallyEmitMessage events: those carry their
  // own messageId and bypass this field entirely.
  currentTextMessageId?: string;
}

export type MessagesInProgressRecord = Record<string, MessageInProgress | null>;

// The following types are our own definition to the messages accepted by LangGraph Platform, enhanced with some of our extra data.
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type BaseLangGraphPlatformMessage = Omit<
  LangGraphMessage,
  | "isResultMessage"
  | "isTextMessage"
  | "isImageMessage"
  | "isActionExecutionMessage"
  | "isAgentStateMessage"
  | "type"
  | "createdAt"
> & {
  content: string;
  role: string;
  additional_kwargs?: Record<string, unknown>;
  type: MessageType;
};

interface LangGraphPlatformResultMessage extends BaseLangGraphPlatformMessage {
  tool_call_id: string;
  name: string;
}

interface LangGraphPlatformActionExecutionMessage
  extends BaseLangGraphPlatformMessage {
  tool_calls: ToolCall[];
}

export type LangGraphPlatformMessage =
  | LangGraphPlatformActionExecutionMessage
  | LangGraphPlatformResultMessage
  | BaseLangGraphPlatformMessage;

export enum CustomEventNames {
  ManuallyEmitMessage = "manually_emit_message",
  ManuallyEmitToolCall = "manually_emit_tool_call",
  ManuallyEmitState = "manually_emit_state",
  Exit = "exit",
}

export interface PredictStateTool {
  tool: string;
  state_key: string;
  tool_argument: string;
}

export interface LangGraphReasoning {
  type: "text";
  text: string;
  index: number;
  signature?: string;
  // The provider's canonical id for the reasoning item (e.g. OpenAI
  // `rs_…`), when the stream carries one. Used as the AG-UI reasoning
  // message id so the streamed message reconciles with the snapshot copy
  // emitted under the same id.
  id?: string;
}
