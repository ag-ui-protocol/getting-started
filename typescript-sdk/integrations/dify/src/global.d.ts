declare module "@ag-ui/client" {
  export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, any>;
  }

  export interface RunAgentInput {
    threadId: string;
    runId: string;
    messages: any[];
    tools?: Tool[];
  }

  export enum EventType {
    RUN_STARTED = "run_started",
    RUN_FINISHED = "run_finished",
    TEXT_MESSAGE_START = "text_message_start",
    TEXT_MESSAGE_CONTENT = "text_message_content",
    TEXT_MESSAGE_END = "text_message_end",
    TOOL_CALL_START = "tool_call_start",
    TOOL_CALL_ARGS = "tool_call_args",
    TOOL_CALL_END = "tool_call_end",
  }

  export interface AGUIEvent {
    type: EventType;
    timestamp: Date;
    threadId?: string;
    runId?: string;
    messageId?: string;
    role?: string;
    delta?: string;
    toolCallId?: string;
    toolCallName?: string;
    result?: string;
  }

  export abstract class AbstractAgent {
    constructor(config?: any);
    abstract stream(input: RunAgentInput): AsyncGenerator<AGUIEvent>;
  }
} 