/**
 * Regression tests for issue #2014.
 *
 * On a HITL resume, `handleStreamEvents` resets `emittedToolCallStartIds` to a
 * fresh Set, so `OnToolEnd`'s synthetic TOOL_CALL_START/ARGS/END triple — gated
 * only on that per-run Set — re-announces a tool call the frontend already
 * received in the prior run. That makes the parent text flash and the tool call
 * revert to a loading state when MESSAGES_SNAPSHOT lands.
 *
 * The fix dedupes against the durable thread history in `this.messages` (the
 * full conversation the client replays on resume): if the originating assistant
 * message for the tool call is already present, the synthetic triple is skipped.
 * TOOL_CALL_RESULT still fires normally.
 */

import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

function makeConfig(): LangGraphAgentConfig {
  return { deploymentUrl: "http://localhost:2024", graphId: "test-graph" };
}

function createAgent(messages: any[] = []) {
  const agent = new LangGraphAgent(makeConfig());
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return event as any;
  };
  (agent as any).activeRun = {
    id: "run-2",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  (agent as any).emittedToolCallStartIds = new Set<string>();
  agent.messages = messages as any;
  return { agent, dispatched };
}

/** An assistant message that already announced `toolCallId` in a prior run. */
function priorAssistantMessage(toolCallId: string) {
  return {
    id: "asst-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: toolCallId,
        type: "function",
        function: { name: "my_tool", arguments: "{}" },
      },
    ],
  };
}

function singleToolEndEvent(toolCallId: string) {
  return {
    event: "on_tool_end",
    metadata: { langgraph_node: "tools" },
    data: {
      input: { foo: "bar" },
      output: { tool_call_id: toolCallId, name: "my_tool", content: "Done." },
    },
  };
}

function commandToolEndEvent(toolCallId: string) {
  // LangGraph's Command-style shape: tool message nested in update.messages.
  return {
    event: "on_tool_end",
    metadata: { langgraph_node: "tools" },
    data: {
      input: { foo: "bar" },
      output: {
        update: {
          messages: [
            {
              type: "tool",
              tool_call_id: toolCallId,
              name: "my_tool",
              content: "Done.",
              id: "msg-1",
            },
          ],
        },
      },
    },
  };
}

const startEvents = (d: any[]) => d.filter((e) => e.type === EventType.TOOL_CALL_START);
const resultEvents = (d: any[]) => d.filter((e) => e.type === EventType.TOOL_CALL_RESULT);

describe("issue #2014: OnToolEnd must not re-emit TOOL_CALL_START on HITL resume", () => {
  it("skips the synthetic triple when the tool call is already in prior-run history (single path)", () => {
    const toolCallId = "tc-resumed";
    const { agent, dispatched } = createAgent([priorAssistantMessage(toolCallId)]);

    agent.handleSingleEvent(singleToolEndEvent(toolCallId));

    // Re-announcement suppressed, result still delivered.
    expect(startEvents(dispatched)).toHaveLength(0);
    expect(
      dispatched.filter((e) => e.type === EventType.TOOL_CALL_ARGS),
    ).toHaveLength(0);
    expect(
      dispatched.filter((e) => e.type === EventType.TOOL_CALL_END),
    ).toHaveLength(0);
    expect(resultEvents(dispatched)).toHaveLength(1);
    expect(resultEvents(dispatched)[0].toolCallId).toBe(toolCallId);
  });

  it("skips the synthetic triple on resume for the Command/update.messages path", () => {
    const toolCallId = "tc-resumed-cmd";
    const { agent, dispatched } = createAgent([priorAssistantMessage(toolCallId)]);

    agent.handleSingleEvent(commandToolEndEvent(toolCallId));

    expect(startEvents(dispatched)).toHaveLength(0);
    expect(resultEvents(dispatched)).toHaveLength(1);
    expect(resultEvents(dispatched)[0].toolCallId).toBe(toolCallId);
  });

  it("still emits START/ARGS/END for a fresh tool call not present in history", () => {
    const toolCallId = "tc-fresh";
    const { agent, dispatched } = createAgent([]); // no prior history

    agent.handleSingleEvent(singleToolEndEvent(toolCallId));

    expect(startEvents(dispatched)).toHaveLength(1);
    expect(startEvents(dispatched)[0].toolCallId).toBe(toolCallId);
    expect(resultEvents(dispatched)).toHaveLength(1);
  });
});
