import { mergeMap } from "rxjs/operators";
import jsonpatch from "fast-json-patch";

import {
  BaseEvent,
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  CustomEvent,
  StateSnapshotEvent,
  StepStartedEvent,
  Message,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  ToolCall,
  RunErrorEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
import {
  LegacyTextMessageStart,
  LegacyTextMessageContent,
  LegacyTextMessageEnd,
  LegacyActionExecutionStart,
  LegacyActionExecutionArgs,
  LegacyActionExecutionEnd,
  LegacyRuntimeEventTypes,
  LegacyRuntimeProtocolEvent,
  LegacyMetaEvent,
  LegacyAgentStateMessage,
  LegacyMessage,
  LegacyTextMessage,
  LegacyActionExecutionMessage,
  LegacyResultMessage,
  LegacyActionExecutionResult,
  LegacyRunError,
} from "./types";
import untruncateJson from "untruncate-json";

const flattenMessageContentToText = (content: Message["content"]) => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .filter((text) => text.length > 0);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n");
};

interface PredictStateValue {
  state_key: string;
  tool: string;
  tool_argument: string;
}

export const convertToLegacyEvents =
  (threadId: string, runId: string, agentName: string) =>
  (events$: Observable<BaseEvent>): Observable<LegacyRuntimeProtocolEvent> => {
    let currentState: Record<string, unknown> = {};
    let running = true;
    let active = true;
    let nodeName = "";
    let syncedMessages: Message[] | null = null;
    let predictState: PredictStateValue[] | null = null;
    let currentToolCalls: ToolCall[] = [];
    const toolCallNames: Record<string, string> = {};

    const updateCurrentState = (newState: Record<string, unknown>) => {
      // the legacy protocol will only support object state
      if (typeof newState === "object" && newState !== null) {
        if ("messages" in newState) {
          delete newState.messages;
        }
        currentState = newState;
      }
    };

    return events$.pipe(
      mergeMap((event) => {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_START: {
            const startEvent = event as TextMessageStartEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.TextMessageStart,
                messageId: startEvent.messageId,
                role: startEvent.role,
              } as LegacyTextMessageStart,
            ];
          }
          case EventType.TEXT_MESSAGE_CONTENT: {
            const contentEvent = event as TextMessageContentEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.TextMessageContent,
                messageId: contentEvent.messageId,
                content: contentEvent.delta,
              } as LegacyTextMessageContent,
            ];
          }
          case EventType.TEXT_MESSAGE_END: {
            const endEvent = event as TextMessageEndEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.TextMessageEnd,
                messageId: endEvent.messageId,
              } as LegacyTextMessageEnd,
            ];
          }
          case EventType.TOOL_CALL_START: {
            const startEvent = event as ToolCallStartEvent;

            currentToolCalls.push({
              id: startEvent.toolCallId,
              type: "function",
              function: {
                name: startEvent.toolCallName,
                arguments: "",
              },
            });

            active = true;
            toolCallNames[startEvent.toolCallId] = startEvent.toolCallName;

            return [
              {
                type: LegacyRuntimeEventTypes.enum.ActionExecutionStart,
                actionExecutionId: startEvent.toolCallId,
                actionName: startEvent.toolCallName,
                parentMessageId: startEvent.parentMessageId,
              } as LegacyActionExecutionStart,
            ];
          }
          case EventType.TOOL_CALL_ARGS: {
            const argsEvent = event as ToolCallArgsEvent;

            // Find the tool call by ID instead of using the last one
            const currentToolCall = currentToolCalls.find((tc) => tc.id === argsEvent.toolCallId);
            if (!currentToolCall) {
              console.warn(`TOOL_CALL_ARGS: No tool call found with ID '${argsEvent.toolCallId}'`);
              return [];
            }

            currentToolCall.function.arguments += argsEvent.delta;
            let didUpdateState = false;

            if (predictState) {
              const currentPredictState = predictState.find(
                (s) => s.tool == currentToolCall.function.name,
              );

              if (currentPredictState) {
                try {
                  const currentArgs = JSON.parse(
                    untruncateJson(currentToolCall.function.arguments),
                  );
                  if (
                    currentPredictState.tool_argument &&
                    currentPredictState.tool_argument in currentArgs
                  ) {
                    updateCurrentState({
                      ...currentState,
                      [currentPredictState.state_key]:
                        currentArgs[currentPredictState.tool_argument],
                    });
                    didUpdateState = true;
                  } else if (!currentPredictState.tool_argument) {
                    updateCurrentState({
                      ...currentState,
                      [currentPredictState.state_key]: currentArgs,
                    });
                    didUpdateState = true;
                  }
                } catch (_e) {
                  // Partial predictive-state args are expected to be
                  // unparseable until the tool call completes.
                }
              }
            }

            return [
              {
                type: LegacyRuntimeEventTypes.enum.ActionExecutionArgs,
                actionExecutionId: argsEvent.toolCallId,
                args: argsEvent.delta,
              } as LegacyActionExecutionArgs,
              ...(didUpdateState
                ? [
                    {
                      type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                      threadId,
                      agentName,
                      nodeName,
                      runId,
                      running,
                      role: "assistant",
                      state: JSON.stringify(currentState),
                      active,
                    },
                  ]
                : []),
            ];
          }
          case EventType.TOOL_CALL_END: {
            const endEvent = event as ToolCallEndEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.ActionExecutionEnd,
                actionExecutionId: endEvent.toolCallId,
              } as LegacyActionExecutionEnd,
            ];
          }
          case EventType.TOOL_CALL_RESULT: {
            const resultEvent = event as ToolCallResultEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.ActionExecutionResult,
                actionExecutionId: resultEvent.toolCallId,
                result: resultEvent.content,
                actionName: toolCallNames[resultEvent.toolCallId] || "unknown",
              } as LegacyActionExecutionResult,
            ];
          }
          case EventType.RAW: {
            // The legacy protocol doesn't support raw events
            return [];
          }
          case EventType.CUSTOM: {
            const customEvent = event as CustomEvent;
            switch (customEvent.name) {
              case "Exit":
                running = false;
                break;
              case "PredictState":
                predictState = customEvent.value as PredictStateValue[];
                break;
            }

            return [
              {
                type: LegacyRuntimeEventTypes.enum.MetaEvent,
                name: customEvent.name,
                value: customEvent.value,
              } as LegacyMetaEvent,
            ];
          }
          case EventType.STATE_SNAPSHOT: {
            const stateEvent = event as StateSnapshotEvent;
            updateCurrentState(stateEvent.snapshot);

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.STATE_DELTA: {
            const deltaEvent = event as StateDeltaEvent;
            const result = jsonpatch.applyPatch(currentState, deltaEvent.delta, true, false);
            if (!result) {
              return [];
            }
            updateCurrentState(result.newDocument);

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.MESSAGES_SNAPSHOT: {
            const messagesSnapshot = event as MessagesSnapshotEvent;
            syncedMessages = messagesSnapshot.messages;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify({
                  ...currentState,
                  ...(syncedMessages ? { messages: syncedMessages } : {}),
                }),
                active: true,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.RUN_STARTED: {
            // There is nothing to do in the legacy protocol
            return [];
          }
          case EventType.RUN_FINISHED: {
            if (syncedMessages) {
              currentState.messages = syncedMessages;
            }

            // Only do an update if state is not empty
            if (Object.keys(currentState).length === 0) {
              return [];
            }

            let legacyMessages: LegacyMessage[] | null = null;
            if (syncedMessages) {
              try {
                legacyMessages = convertMessagesToLegacyFormat(syncedMessages);
              } catch (error) {
                // Surface the failure on the stream instead of tearing it down
                // with an opaque JSON parsing error.
                return [
                  {
                    type: LegacyRuntimeEventTypes.enum.RunError,
                    message: (error as Error).message,
                  } as LegacyRunError,
                ];
              }
            }

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify({
                  ...currentState,
                  ...(legacyMessages ? { messages: legacyMessages } : {}),
                }),
                active: false,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.RUN_ERROR: {
            const errorEvent = event as RunErrorEvent;
            return [
              {
                type: LegacyRuntimeEventTypes.enum.RunError,
                message: errorEvent.message,
                code: errorEvent.code,
              } as LegacyRunError,
            ];
          }
          case EventType.STEP_STARTED: {
            const stepStarted = event as StepStartedEvent;
            nodeName = stepStarted.stepName;

            currentToolCalls = [];
            predictState = null;

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active: true,
              } as LegacyAgentStateMessage,
            ];
          }
          case EventType.STEP_FINISHED: {
            currentToolCalls = [];
            predictState = null;

            return [
              {
                type: LegacyRuntimeEventTypes.enum.AgentStateMessage,
                threadId,
                agentName,
                nodeName,
                runId,
                running,
                role: "assistant",
                state: JSON.stringify(currentState),
                active: false,
              } as LegacyAgentStateMessage,
            ];
          }
          default: {
            return [];
          }
        }
      }),
    );
  };

export function convertMessagesToLegacyFormat(messages: Message[]): LegacyMessage[] {
  const result: LegacyMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" || message.role === "user" || message.role === "system") {
      const textContent = flattenMessageContentToText(message.content);
      if (textContent) {
        const textMessage: LegacyTextMessage = {
          id: message.id,
          role: message.role,
          content: textContent,
        };
        result.push(textMessage);
      }
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        for (const toolCall of message.toolCalls) {
          let parsedArguments: unknown;
          try {
            parsedArguments = JSON.parse(toolCall.function.arguments);
          } catch (error) {
            throw new Error(
              `Failed to parse arguments for tool call '${toolCall.id}' ` +
                `(${toolCall.function.name}): ${(error as Error).message}`,
            );
          }
          const actionExecutionMessage: LegacyActionExecutionMessage = {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: parsedArguments,
            parentMessageId: message.id,
          };
          result.push(actionExecutionMessage);
        }
      }
    } else if (message.role === "tool") {
      let actionName = "unknown";
      for (const m of messages) {
        if (m.role === "assistant" && m.toolCalls?.length) {
          for (const toolCall of m.toolCalls) {
            if (toolCall.id === message.toolCallId) {
              actionName = toolCall.function.name;
              break;
            }
          }
        }
      }
      const toolMessage: LegacyResultMessage = {
        id: message.id,
        result: message.content,
        actionExecutionId: message.toolCallId,
        actionName,
      };
      result.push(toolMessage);
    }
  }

  return result;
}
