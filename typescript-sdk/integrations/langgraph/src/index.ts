import { Observable, Subscriber } from "rxjs";
import {
  Client as LangGraphClient,
  EventsStreamEvent,
  StreamMode,
  Config as LangGraphConfig,
  ThreadState,
  Assistant,
  Message as LangGraphMessage,
  Config,
  Interrupt,
} from "@langchain/langgraph-sdk";
import { randomUUID } from "node:crypto";
import { RemoveMessage } from "@langchain/core/messages";
import {
  LangGraphPlatformMessage,
  CustomEventNames,
  LangGraphEventTypes,
  State,
  MessagesInProgressRecord,
  SchemaKeys,
  MessageInProgress,
  RunMetadata,
  PredictStateTool,
} from "./types";
import {
  CustomEvent,
  EventType,
  MessagesSnapshotEvent,
  RawEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { AbstractAgent, AgentConfig } from "@ag-ui/client";
import { RunsStreamPayload } from "@langchain/langgraph-sdk/dist/types";
import {
  aguiMessagesToLangChain,
  DEFAULT_SCHEMA_KEYS,
  filterObjectBySchemaKeys,
  getStreamPayloadInput,
  langchainMessagesToAgui,
} from "@/utils";

export type ProcessedEvents =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | RawEvent
  | CustomEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent;

type RunAgentExtendedInput<
  TStreamMode extends StreamMode | StreamMode[] = StreamMode,
  TSubgraphs extends boolean = false,
> = Omit<RunAgentInput, "forwardedProps"> & {
  forwardedProps?: Omit<RunsStreamPayload<TStreamMode, TSubgraphs>, "input"> & {
    nodeName?: string;
  };
};

export interface LangGraphAgentConfig extends AgentConfig {
  client?: LangGraphClient;
  deploymentUrl: string;
  langsmithApiKey?: string;
  propertyHeaders?: Record<string, string>;
  assistantConfig?: LangGraphConfig;
  agentName?: string;
  graphId: string;
}

export class LangGraphAgent extends AbstractAgent {
  client: LangGraphClient;
  assistantConfig?: LangGraphConfig;
  agentName?: string;
  graphId: string;
  assistant?: Assistant;
  messagesInProcess: MessagesInProgressRecord;
  activeRun?: RunMetadata;
  // @ts-expect-error no need to initialize subscriber right now
  subscriber: Subscriber<ProcessedEvents>;

  constructor(config: LangGraphAgentConfig) {
    super(config);
    this.messagesInProcess = {};
    this.agentName = config.agentName;
    this.graphId = config.graphId;
    this.assistantConfig = config.assistantConfig;
    this.client =
      config?.client ??
      new LangGraphClient({
        apiUrl: config.deploymentUrl,
        apiKey: config.langsmithApiKey,
        defaultHeaders: { ...(config.propertyHeaders ?? {}) },
      });
  }

  dispatchEvent(event: ProcessedEvents) {
    this.subscriber.next(event);
    return true;
  }

  run(input: RunAgentInput) {
    this.activeRun = {
      id: input.runId,
      threadId: input.threadId,
    };
    return new Observable<ProcessedEvents>((subscriber) => {
      this.handleStreamEvents(input, subscriber);
      return () => {};
    });
  }

  async handleStreamEvents(input: RunAgentExtendedInput, subscriber: Subscriber<ProcessedEvents>) {
    let { threadId: inputThreadId, state, messages, tools, context, forwardedProps } = input;
    this.subscriber = subscriber;
    let shouldExit = false;
    // If a manual emittance happens, it is the ultimate source of truth of state, unless a node has exited.
    // Therefore, this value should either hold null, or the only edition of state that should be used.
    this.activeRun!.manuallyEmittedState = null;

    this.activeRun!.nodeName = input.forwardedProps?.nodeName;

    const threadId = inputThreadId ?? randomUUID();

    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }

    let agentState = await this.getOrCreateThreadAndReturnState(threadId);

    const agentStateValues = agentState.values as State;
    const aguiToLangChainMessage = aguiMessagesToLangChain(messages);

    state.messages = agentStateValues.messages;
    state = this.langGraphDefaultMergeState(state, aguiToLangChainMessage, tools);

    const mode =
      threadId && this.activeRun!.nodeName != "__end__" && this.activeRun!.nodeName
        ? "continue"
        : "start";

    if (mode === "continue" && !forwardedProps?.command?.resume) {
      await this.client.threads.updateState(threadId, {
        values: state,
        asNode: this.activeRun!.nodeName,
      });
    }

    this.activeRun!.schemaKeys = await this.getSchemaKeys();

    const payloadInput = getStreamPayloadInput({
      mode,
      state,
      schemaKeys: this.activeRun!.schemaKeys,
    });

    const graphInfo = await this.client.assistants.getGraph(this.assistant.assistant_id);

    let payloadConfig: LangGraphConfig | undefined;
    const configsToMerge = [this.assistantConfig, forwardedProps?.config].filter(
      Boolean,
    ) as LangGraphConfig[];
    if (configsToMerge.length) {
      payloadConfig = await this.mergeConfigs({
        configs: configsToMerge,
        assistant: this.assistant,
        schemaKeys: this.activeRun!.schemaKeys,
      });
    }
    const payload = {
      ...forwardedProps,
      streamMode:
        forwardedProps?.streamMode ?? (["events", "values", "updates"] satisfies StreamMode[]),
      input: payloadInput,
      config: payloadConfig,
    };

    // If there are still outstanding unresolved interrupts, we must force resolution of them before moving forward
    const interrupts = (agentState.tasks?.[0]?.interrupts ?? []) as Interrupt[];
    if (interrupts?.length && !forwardedProps?.command?.resume) {
      this.dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: input.runId,
      });

      interrupts.forEach((interrupt) => {
        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: LangGraphEventTypes.OnInterrupt,
          value:
            typeof interrupt.value === "string" ? interrupt.value : JSON.stringify(interrupt.value),
          rawEvent: interrupt,
        });
      });

      this.dispatchEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: input.runId,
      });
      return subscriber.complete();
    }
    const streamResponse = this.client.runs.stream(threadId, this.assistant.assistant_id, payload);

    this.activeRun!.prevNodeName = null;
    let latestStateValues = {};
    let updatedState = state;

    try {
      this.dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: this.activeRun!.id,
      });

      for await (let streamResponseChunk of streamResponse) {
        // @ts-ignore
        if (!payload.streamMode.includes(streamResponseChunk.event as StreamMode)) {
          continue;
        }
        // Force event type, as data is not properly defined on the LG side.
        type EventsChunkData = {
          __interrupt__?: any;
          metadata: Record<string, any>;
          event: string;
          data: any;
          [key: string]: unknown;
        };
        const chunk = streamResponseChunk as EventsStreamEvent & { data: EventsChunkData };

        if (streamResponseChunk.event === "error") {
          this.dispatchEvent({
            type: EventType.RUN_ERROR,
            message: streamResponseChunk.data.message,
            rawEvent: streamResponseChunk,
          });
          break;
        }

        if (streamResponseChunk.event === "updates") continue;

        if (streamResponseChunk.event === "values") {
          latestStateValues = chunk.data;
          continue;
        }

        const chunkData = chunk.data;
        const currentNodeName = chunkData.metadata.langgraph_node;
        const eventType = chunkData.event;
        const metadata = chunkData.metadata;
        this.activeRun!.id = metadata.run_id;

        if (currentNodeName && currentNodeName !== this.activeRun!.nodeName) {
          if (this.activeRun!.nodeName) {
            this.dispatchEvent({
              type: EventType.STEP_FINISHED,
              stepName: this.activeRun!.nodeName,
            });
          }

          if (currentNodeName) {
            this.dispatchEvent({
              type: EventType.STEP_STARTED,
              stepName: currentNodeName,
            });
            this.activeRun!.nodeName = currentNodeName;
          }
        }

        shouldExit =
          shouldExit ||
          (eventType === LangGraphEventTypes.OnCustomEvent &&
            chunkData.name === CustomEventNames.Exit);

        this.activeRun!.exitingNode =
          this.activeRun!.nodeName === currentNodeName &&
          eventType === LangGraphEventTypes.OnChainEnd;
        if (this.activeRun!.exitingNode) {
          this.activeRun!.manuallyEmittedState = null;
        }

        // we only want to update the node name under certain conditions
        // since we don't need any internal node names to be sent to the frontend
        if (graphInfo["nodes"].some((node) => node.id === currentNodeName)) {
          this.activeRun!.nodeName = currentNodeName;
        }

        updatedState = this.activeRun!.manuallyEmittedState ?? latestStateValues;

        if (!this.activeRun!.nodeName) {
          continue;
        }

        const hasStateDiff = JSON.stringify(updatedState) !== JSON.stringify(state);
        // We should not update snapshot while a message is in progress.
        if (
          (hasStateDiff ||
            this.activeRun!.prevNodeName != this.activeRun!.nodeName ||
            this.activeRun!.exitingNode) &&
          !Boolean(this.getMessageInProgress(this.activeRun!.id))
        ) {
          state = updatedState;
          this.activeRun!.prevNodeName = this.activeRun!.nodeName;

          this.dispatchEvent({
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.getStateSnapshot(state),
            rawEvent: chunk,
          });
        }

        this.dispatchEvent({
          type: EventType.RAW,
          event: chunkData,
        });

        this.handleSingleEvent(chunkData, state);
      }

      state = await this.client.threads.getState(threadId);
      const interrupts = (state.tasks?.[0]?.interrupts ?? []) as Interrupt[];
      this.activeRun!.nodeName = interrupts
        ? this.activeRun!.nodeName
        : Object.keys(state.metadata.writes)[0];

      interrupts.forEach((interrupt) => {
        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: LangGraphEventTypes.OnInterrupt,
          value:
            typeof interrupt.value === "string" ? interrupt.value : JSON.stringify(interrupt.value),
          rawEvent: interrupt,
        });
      });

      this.dispatchEvent({
        type: EventType.STATE_SNAPSHOT,
        snapshot: this.getStateSnapshot(state.values),
      });
      this.dispatchEvent({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: langchainMessagesToAgui(state.values.messages ?? []),
      });
      if (this.activeRun!.nodeName) {
        this.dispatchEvent({
          type: EventType.STEP_FINISHED,
          stepName: this.activeRun!.nodeName!,
        });
      }
      this.dispatchEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: this.activeRun!.id,
      });
      return subscriber.complete();
    } catch (e) {
      return subscriber.error(e);
    }
  }

  handleSingleEvent(event: any, state: State): void {
    switch (event.event) {
      case LangGraphEventTypes.OnChatModelStream:
        let shouldEmitMessages = event.metadata["emit-messages"] ?? true;
        let shouldEmitToolCalls = event.metadata["emit-tool-calls"] ?? true;

        if (event.data.chunk.response_metadata.finish_reason) return;
        const currentStream = this.getMessageInProgress(this.activeRun!.id);
        const hasCurrentStream = Boolean(currentStream?.id);
        const toolCallData = event.data.chunk.tool_call_chunks?.[0];
        const toolCallUsedToPredictState = event.metadata["predict_state"]?.some(
          (predictStateTool: PredictStateTool) => predictStateTool.tool === toolCallData?.name,
        );

        const isToolCallStartEvent = !hasCurrentStream && toolCallData?.name;
        const isToolCallArgsEvent =
          hasCurrentStream && currentStream?.toolCallId && toolCallData.args;
        const isToolCallEndEvent = hasCurrentStream && currentStream?.toolCallId && !toolCallData;

        const isMessageStartEvent = !hasCurrentStream && !toolCallData;
        const isMessageContentEvent = hasCurrentStream && !toolCallData;
        const isMessageEndEvent =
          hasCurrentStream && !currentStream?.toolCallId && !isMessageContentEvent;

        if (toolCallUsedToPredictState) {
          this.dispatchEvent({
            type: EventType.CUSTOM,
            name: "PredictState",
            value: event.metadata["predict_state"],
          });
        }

        if (isToolCallEndEvent) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: currentStream.toolCallId!,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }

        if (isMessageEndEvent) {
          const resolved = this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentStream!.id,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }

        if (isToolCallStartEvent && shouldEmitToolCalls) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: toolCallData.id,
            toolCallName: toolCallData.name,
            parentMessageId: event.data.chunk.id,
            rawEvent: event,
          });
          if (resolved) {
            this.setMessageInProgress(this.activeRun!.id, {
              id: event.data.chunk.id,
              toolCallId: toolCallData.id,
              toolCallName: toolCallData.name,
            });
          }
          break;
        }

        // Tool call args: emit ActionExecutionArgs
        if (isToolCallArgsEvent && shouldEmitToolCalls) {
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: currentStream.toolCallId!,
            delta: toolCallData.args,
            rawEvent: event,
          });
          break;
        }

        // Message started: emit TextMessageStart
        if (isMessageStartEvent && shouldEmitMessages) {
          const resolved = this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_START,
            role: "assistant",
            messageId: event.data.chunk.id,
            rawEvent: event,
          });
          if (resolved) {
            this.setMessageInProgress(this.activeRun!.id, {
              id: event.data.chunk.id,
              toolCallId: null,
              toolCallName: null,
            });
          }
          break;
        }
        // Message content: emit TextMessageContent
        if (isMessageContentEvent && shouldEmitMessages) {
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: currentStream!.id,
            delta: event.data.chunk.content,
            rawEvent: event,
          });
          break;
        }

        break;
      case LangGraphEventTypes.OnChatModelEnd:
        if (this.getMessageInProgress(this.activeRun!.id)?.toolCallId) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: this.getMessageInProgress(this.activeRun!.id)!.toolCallId!,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }
        if (this.getMessageInProgress(this.activeRun!.id)?.id) {
          const resolved = this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: this.getMessageInProgress(this.activeRun!.id)!.id,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }
        break;
      case LangGraphEventTypes.OnCustomEvent:
        if (event.name === CustomEventNames.ManuallyEmitMessage) {
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_START,
            role: "assistant",
            messageId: event.data.message_id,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: event.data.message_id,
            delta: event.data.message,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: event.data.message_id,
            rawEvent: event,
          });
          break;
        }

        if (event.name === CustomEventNames.ManuallyEmitToolCall) {
          this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: event.data.id,
            toolCallName: event.data.name,
            parentMessageId: event.data.id,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: event.data.id,
            delta: event.data.args,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: event.data.id,
            rawEvent: event,
          });
          break;
        }

        if (event.name === CustomEventNames.ManuallyEmitState) {
          this.activeRun!.manuallyEmittedState = event.data;
          this.dispatchEvent({
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.getStateSnapshot(state),
            rawEvent: event,
          });
        }

        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: event.name,
          value: event.data,
          rawEvent: event,
        });
        break;
    }
  }

  getStateSnapshot(state: State) {
    const schemaKeys = this.activeRun!.schemaKeys!;
    // Do not emit state keys that are not part of the output schema
    if (schemaKeys?.output) {
      state = filterObjectBySchemaKeys(state, [...DEFAULT_SCHEMA_KEYS, ...schemaKeys.output]);
    }
    // return state
    return state;
  }

  async getOrCreateThreadAndReturnState(threadId: string): Promise<ThreadState<{}>> {
    let agentState = { values: {} } as ThreadState;
    try {
      await this.client.threads.get(threadId);
      agentState = await this.client.threads.getState(threadId);
    } catch (error) {
      await this.client.threads.create({ threadId });
    }

    return agentState;
  }

  async mergeConfigs({
    configs,
    assistant,
    schemaKeys,
  }: {
    configs: Config[];
    assistant: Assistant;
    schemaKeys: SchemaKeys;
  }) {
    return configs.reduce((acc, cfg) => {
      let filteredConfigurable = acc.configurable;

      if (cfg.configurable) {
        filteredConfigurable = schemaKeys?.config
          ? filterObjectBySchemaKeys(cfg?.configurable, [
              ...DEFAULT_SCHEMA_KEYS,
              ...(schemaKeys?.config ?? []),
            ])
          : cfg?.configurable;
      }

      const newConfig = {
        ...acc,
        ...cfg,
        configurable: filteredConfigurable,
      };

      // LG does not return recursion limit if it's the default, therefore we check: if no recursion limit is currently set, and the user asked for 25, there is no change.
      const isRecursionLimitSetToDefault =
        acc.recursion_limit == null && cfg.recursion_limit === 25;
      // Deep compare configs to avoid unnecessary update calls
      const configsAreDifferent = JSON.stringify(newConfig) !== JSON.stringify(acc);

      // Check if the only difference is the recursion_limit being set to default
      const isOnlyRecursionLimitDifferent =
        isRecursionLimitSetToDefault &&
        JSON.stringify({ ...newConfig, recursion_limit: null }) ===
          JSON.stringify({ ...acc, recursion_limit: null });

      if (configsAreDifferent && !isOnlyRecursionLimitDifferent) {
        return {
          ...acc,
          ...newConfig,
        };
      }

      return acc;
    }, assistant.config);
  }

  getMessageInProgress(runId: string) {
    return this.messagesInProcess[runId];
  }

  setMessageInProgress(runId: string, data: MessageInProgress) {
    this.messagesInProcess = {
      ...this.messagesInProcess,
      [runId]: {
        ...(this.messagesInProcess[runId] as MessageInProgress),
        ...data,
      },
    };
  }

  async getAssistant(): Promise<Assistant> {
    const assistants = await this.client.assistants.search();
    const retrievedAssistant = assistants.find(
      (searchResult) =>
        searchResult.assistant_id === this.agentId || searchResult.graph_id === this.graphId,
    );
    if (!retrievedAssistant) {
      console.error(`
      No agent found with graph ID ${this.graphId} or agent ID ${this.agentId} found..\n
      
      These are the available agents: [${assistants.map((a) => `${a.graph_id} (ID: ${a.assistant_id})`).join(", ")}]
      `);
      throw new Error("No agent id found");
    }

    return retrievedAssistant;
  }

  async getSchemaKeys(): Promise<SchemaKeys> {
    const CONSTANT_KEYS = ["messages"];

    try {
      const graphSchema = await this.client.assistants.getSchemas(this.assistant!.assistant_id);
      let configSchema = null;
      if (graphSchema.config_schema?.properties) {
        configSchema = Object.keys(graphSchema.config_schema.properties);
      }
      if (!graphSchema.input_schema?.properties || !graphSchema.output_schema?.properties) {
        return { config: [], input: CONSTANT_KEYS, output: CONSTANT_KEYS };
      }
      const inputSchema = Object.keys(graphSchema.input_schema.properties);
      const outputSchema = Object.keys(graphSchema.output_schema.properties);

      return {
        input: inputSchema && inputSchema.length ? [...inputSchema, ...CONSTANT_KEYS] : null,
        output: outputSchema && outputSchema.length ? [...outputSchema, ...CONSTANT_KEYS] : null,
        config: configSchema,
      };
    } catch (e) {
      return { config: [], input: CONSTANT_KEYS, output: CONSTANT_KEYS };
    }
  }

  langGraphDefaultMergeState(state: State, messages: LangGraphMessage[], tools: any): State {
    if (messages.length > 0 && "role" in messages[0] && messages[0].role === "system") {
      // remove system message
      messages = messages.slice(1);
    }

    // merge with existing messages
    const existingMessages: LangGraphPlatformMessage[] = state.messages || [];
    const existingMessageIds = new Set(existingMessages.map((message) => message.id));
    const messageIds = new Set(messages.map((message) => message.id));

    let removedMessages: RemoveMessage[] = [];
    if (messages.length < existingMessages.length) {
      // Messages were removed
      removedMessages = existingMessages
        .filter((m) => !messageIds.has(m.id))
        .map((m) => new RemoveMessage({ id: m.id! }));
    }

    const newMessages = messages.filter((message) => !existingMessageIds.has(message.id));

    return {
      ...state,
      messages: [...removedMessages, ...newMessages],
      tools: [...(state.tools ?? []), ...tools],
    };
  }
}

export * from './types'
