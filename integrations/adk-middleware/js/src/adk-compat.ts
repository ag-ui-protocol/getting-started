import type { AuthConfig, Event as AdkEvent } from "@google/adk";

import { isRecord } from "./value-utils";

export const REQUEST_INPUT_FUNCTION_CALL_NAME = "adk_request_input";
export const REQUEST_CREDENTIAL_FUNCTION_CALL_NAME = "adk_request_credential";
export const REQUEST_CONFIRMATION_FUNCTION_CALL_NAME =
  "adk_request_confirmation";

export type UserInputKind = "input" | "credential" | "confirmation";

/**
 * Structural form of ADK's user-input request. Kept local because the helper
 * was added to ADK source after the 1.6.0 package entry point was published.
 */
export interface UserInputRequest {
  kind: UserInputKind;
  interruptId: string;
  functionCallName: string;
  author?: string;
  message?: string;
  payload?: unknown;
  responseSchema?: unknown;
  toolName?: string;
  authConfig?: AuthConfig;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse the three ADK interrupt function-call encodings without private imports. */
export function getUserInputRequests(event: AdkEvent): UserInputRequest[] {
  const requests: UserInputRequest[] = [];

  for (const part of event.content?.parts ?? []) {
    const call = part.functionCall;
    if (!call?.name) {
      continue;
    }
    const args = isRecord(call.args) ? call.args : {};
    const interruptId =
      call.id ??
      stringValue(args.interruptId) ??
      stringValue(args.functionCallId) ??
      stringValue(args.function_call_id);
    if (!interruptId) {
      continue;
    }
    const base = {
      interruptId,
      functionCallName: call.name,
      author: event.author,
    };

    if (call.name === REQUEST_INPUT_FUNCTION_CALL_NAME) {
      requests.push({
        ...base,
        kind: "input",
        message: stringValue(args.message),
        payload: args.payload,
        responseSchema: args.response_schema ?? args.responseSchema,
      });
      continue;
    }

    if (call.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
      requests.push({
        ...base,
        kind: "credential",
        message: stringValue(args.message),
        authConfig: (args.authConfig ?? args.auth_config) as
          | AuthConfig
          | undefined,
      });
      continue;
    }

    if (call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
      const confirmation = isRecord(args.toolConfirmation)
        ? args.toolConfirmation
        : isRecord(args.tool_confirmation)
          ? args.tool_confirmation
          : undefined;
      const originalCall = isRecord(args.originalFunctionCall)
        ? args.originalFunctionCall
        : isRecord(args.original_function_call)
          ? args.original_function_call
          : undefined;
      requests.push({
        ...base,
        kind: "confirmation",
        message: stringValue(confirmation?.hint),
        payload: confirmation?.payload,
        toolName: stringValue(originalCall?.name),
      });
    }
  }

  return requests;
}

/** Return requests that do not yet have a later function response by id. */
export function getPendingUserInputRequests(
  events: readonly AdkEvent[],
): UserInputRequest[] {
  const answered = new Set<string>();
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.id) {
        answered.add(part.functionResponse.id);
      }
    }
  }

  const seen = new Set<string>();
  const pending: UserInputRequest[] = [];
  for (const event of events) {
    for (const request of getUserInputRequests(event)) {
      if (answered.has(request.interruptId) || seen.has(request.interruptId)) {
        continue;
      }
      seen.add(request.interruptId);
      pending.push(request);
    }
  }
  return pending;
}

interface AdkWorkflowEventFields {
  output?: unknown;
  nodeInfo?: unknown;
  isolationScope?: string;
}

/**
 * Read workflow fields added to ADK source after its 1.6.0 declarations were
 * published. Keep the version-compatibility check at this single boundary.
 */
export function getAdkWorkflowEventFields(
  event: AdkEvent,
): AdkWorkflowEventFields {
  if (!isRecord(event)) {
    return {};
  }
  return {
    output: event.output,
    nodeInfo: event.nodeInfo,
    ...(typeof event.isolationScope === "string"
      ? { isolationScope: event.isolationScope }
      : {}),
  };
}
