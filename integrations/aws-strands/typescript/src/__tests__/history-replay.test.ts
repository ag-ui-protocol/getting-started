/**
 * History reconciliation (replayHistoryIntoStrands). Fixes the "chart loops
 * forever" symptom: without replay, the LLM never sees the client-produced
 * tool result on the next turn and re-fires the same tool.
 *
 * Python parity: adapter mirrors agent.py's _build_strands_history and
 * stream_async(None) flow.
 */

import { describe, it, expect } from "vitest";
import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

function recordingAgent() {
  const calls: { args: unknown; messages: unknown[] }[] = [];
  const stub = scriptedAgent([], {
    messages: [] as never,
    sessionManager: undefined as never,
    stream: async function* (args: unknown) {
      calls.push({
        args,
        messages: [...(stub as unknown as { messages: unknown[] }).messages],
      });
    } as unknown as import("@strands-agents/sdk").Agent["stream"],
  });
  return { stub, calls };
}

function makeAgent(
  stub: import("@strands-agents/sdk").Agent,
  config?: StrandsAgentConfig,
): StrandsAgent {
  const sa = new StrandsAgent({ agent: stub, name: "t", config });
  const byThread = (sa as unknown as { _agentsByThread: Map<string, unknown> })
    ._agentsByThread;
  byThread.set("thread-1", stub);
  byThread.set("default", stub);
  return sa;
}

describe("replayHistoryIntoStrands", () => {
  it("rebuilds agent.messages before stream() and calls stream(undefined)", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "hi" },
          { id: "u2", role: "user", content: "another" },
        ],
      }),
    );
    expect(calls).toHaveLength(1);
    // stream(undefined) is the signal to Strands: "use my this.messages as-is".
    expect(calls[0]!.args).toBeUndefined();
    expect(calls[0]!.messages).toHaveLength(3);
  });

  it("renders prior tool_calls as toolUse ContentBlocks so the LLM sees them", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "render_chart", arguments: '{"x":1}' },
              },
            ],
          },
          { id: "t1", role: "tool", content: "ok", toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    // 3 turns: user, assistant(toolUse), user(toolResult)
    expect(history).toHaveLength(3);
    expect(history[1]!.role).toBe("assistant");
    // Message.fromMessageData converts plain { toolUse: {...} } objects to
    // ToolUseBlock instances — inspect fields on the instance directly.
    const toolUseBlock = history[1]!.content[0] as {
      type: string;
      toolUseId: string;
      name: string;
    };
    expect(toolUseBlock.type).toBe("toolUseBlock");
    expect(toolUseBlock.toolUseId).toBe("tc1");
    expect(toolUseBlock.name).toBe("render_chart");
    expect(history[2]!.role).toBe("user");
    expect((history[2]!.content[0] as { type: string }).type).toBe(
      "toolResultBlock",
    );
  });

  it("decodes JSON tool result content into a JsonBlock so the LLM sees structure", async () => {
    // Frontends (e.g. CopilotKit useHumanInTheLoop's `respond({...})`) JSON-
    // encode structured results before transport. Forwarding the raw string as
    // a TextBlock leaves the model with the original toolUse.input and an
    // opaque text payload — the model then ignores the user's selection and
    // re-lists the original args. Emit `{json: parsed}` so the result wins.
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    const toolResult = JSON.stringify({
      accepted: true,
      steps: [
        { description: "Crack eggs", status: "enabled" },
        { description: "Mix batter", status: "enabled" },
      ],
    });
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "plan brownies" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: {
                  name: "generate_task_steps",
                  arguments: '{"steps":[]}',
                },
              },
            ],
          },
          { id: "t1", role: "tool", content: toolResult, toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    const toolResultBlock = history[2]!.content[0] as {
      type: string;
      content: Array<{ type: string; text?: string; json?: unknown }>;
    };
    expect(toolResultBlock.type).toBe("toolResultBlock");
    expect(toolResultBlock.content).toHaveLength(1);
    const inner = toolResultBlock.content[0]!;
    expect(inner.type).toBe("jsonBlock");
    expect(inner.json).toEqual({
      accepted: true,
      steps: [
        { description: "Crack eggs", status: "enabled" },
        { description: "Mix batter", status: "enabled" },
      ],
    });
  });

  it("falls back to a TextBlock when tool result content is not JSON", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do x" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "do_x", arguments: "{}" },
              },
            ],
          },
          { id: "t1", role: "tool", content: "plain ack", toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{ content: unknown[] }>;
    const toolResultBlock = history[2]!.content[0] as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(toolResultBlock.content[0]!.type).toBe("textBlock");
    expect(toolResultBlock.content[0]!.text).toBe("plain ack");
  });

  it("is disabled when replayHistoryIntoStrands=false", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub, { replayHistoryIntoStrands: false });
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" }],
      }),
    );
    // Falls back to the legacy path: stream("hello"), agent.messages empty.
    expect(calls[0]!.args).toBe("hello");
    expect(calls[0]!.messages).toHaveLength(0);
  });

  it("is disabled when the agent has a session manager (Strands owns history)", async () => {
    const { stub, calls } = recordingAgent();
    (stub as { sessionManager: unknown }).sessionManager = {
      // presence is enough — adapter only checks truthiness
    };
    const agent = makeAgent(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" }],
      }),
    );
    expect(calls[0]!.args).toBe("hello");
    expect(calls[0]!.messages).toHaveLength(0);
  });
  it("carries a client-reported tool failure onto the toolResult status", async () => {
    // AG-UI models the failure as ToolMessage.error; Bedrock models it as
    // toolResult.status. Hardcoding "success" tells the model a failed
    // frontend tool succeeded. Python parity: agent.py's _build_strands_history
    // (#2317).
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "render_chart", arguments: "{}" },
              },
            ],
          },
          {
            id: "t1",
            role: "tool",
            content: "tool failed: invalid id",
            toolCallId: "tc1",
            error: "invalid id",
          },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{ content: unknown[] }>;
    const block = history[2]!.content[0] as { status: string };
    expect(block.status).toBe("error");
  });

  it("keeps a successful tool result on the success status", async () => {
    const { stub, calls } = recordingAgent();
    const agent = makeAgent(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "render_chart", arguments: "{}" },
              },
            ],
          },
          { id: "t1", role: "tool", content: "ok", toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{ content: unknown[] }>;
    const block = history[2]!.content[0] as { status: string };
    expect(block.status).toBe("success");
  });
});
