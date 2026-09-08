/**
 * Typed stand-ins for the objects the adapter hands to a demo's config hooks.
 *
 * Built from the real exported types rather than cast with `as never`. A cast
 * lets a test keep passing after the field it pokes at has been renamed, which
 * is exactly the assertion that looks like coverage and is not.
 */

import type { RunAgentInput } from "@ag-ui/core";
import type { ToolCallContext, ToolResultContext } from "@ag-ui/aws-strands";

export function runAgentInput(state: unknown = {}): RunAgentInput {
  return {
    threadId: "thread",
    runId: "run",
    messages: [],
    tools: [],
    context: [],
    state,
    forwardedProps: {},
  };
}

export function toolCallContext(
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    inputData: runAgentInput(),
    toolName: "tool",
    toolUseId: "tool-use",
    toolInput: {},
    argsStr: "",
    context: {},
    forwardedProps: {},
    ...overrides,
  };
}

export function toolResultContext(
  overrides: Partial<ToolResultContext> = {},
): ToolResultContext {
  return {
    ...toolCallContext(),
    resultData: {},
    messageId: "message",
    ...overrides,
  };
}
