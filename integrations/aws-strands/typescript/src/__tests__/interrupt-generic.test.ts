/**
 * Generic (non-tool-approval) native interrupts must stay generic.
 *
 * Interrupts NOT raised by the adapter's own interruptOnCall hook (which
 * always uses the "ag_ui:tool_call:" name prefix) — e.g. a user's own tool
 * or hook calling `event.interrupt()` directly for a generic
 * human-in-the-loop request — must be preserved as generic AG-UI
 * interrupts, not misclassified as tool-call approvals with fabricated
 * schema/metadata.
 */
import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  AgentResult as StrandsAgentResult,
  Message as StrandsMessage,
  TextBlock,
  type Interrupt as StrandsInterrupt,
} from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { collect } from "./helpers";

function makeAgentResultStream(result: StrandsAgentResult) {
  return async function* () {
    return result;
  };
}

function buildAgentResult(interrupts: StrandsInterrupt[]): StrandsAgentResult {
  return new StrandsAgentResult({
    stopReason: "interrupt",
    lastMessage: StrandsMessage.fromMessageData({
      role: "assistant",
      content: [new TextBlock("awaiting input").toJSON()],
    }),
    invocationState: {},
    interrupts,
  });
}

function genericStrandsInterrupt(
  id: string,
  name: string,
  reason: unknown,
): StrandsInterrupt {
  return { id, name, reason } as unknown as StrandsInterrupt;
}

describe("Generic native interrupts (not raised by the adapter's own hook)", () => {
  it("preserves the native name as reason instead of fabricating tool_call", async () => {
    const interrupts = [
      genericStrandsInterrupt("int-1", "need_clarification", {
        question: "Which environment?",
      }),
    ];
    const stubAgent = {
      model: { name: "stub-model", modelId: "stub-model" },
      tools: [],
      toolRegistry: { list: () => [] },
      stream: makeAgentResultStream(buildAgentResult(interrupts)) as never,
    };
    const sa = new StrandsAgent({ agent: stubAgent as never, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    const events = await collect(sa);
    const finished = events.at(-1) as BaseEvent & {
      outcome?: { type: string; interrupts?: unknown[] };
    };
    expect(finished.type).toBe(EventType.RUN_FINISHED);
    const first = finished.outcome?.interrupts?.[0] as {
      id: string;
      reason: string;
    };
    expect(first.id).toBe("int-1");
    expect(first.reason).toBe("need_clarification");
  });

  it("does not fabricate a tool-approval responseSchema or toolCallId", async () => {
    const interrupts = [
      genericStrandsInterrupt("int-2", "need_clarification", {
        question: "Which environment?",
      }),
    ];
    const stubAgent = {
      model: { name: "stub-model", modelId: "stub-model" },
      tools: [],
      toolRegistry: { list: () => [] },
      stream: makeAgentResultStream(buildAgentResult(interrupts)) as never,
    };
    const sa = new StrandsAgent({ agent: stubAgent as never, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    const events = await collect(sa);
    const finished = events.at(-1) as BaseEvent & {
      outcome?: { type: string; interrupts?: unknown[] };
    };
    const first = finished.outcome?.interrupts?.[0] as {
      responseSchema?: unknown;
      toolCallId?: string;
    };
    expect(first.responseSchema).toBeUndefined();
    expect(first.toolCallId).toBeUndefined();
  });

  it("preserves the native reason payload in metadata", async () => {
    const interrupts = [
      genericStrandsInterrupt("int-3", "need_clarification", {
        question: "Which environment?",
      }),
    ];
    const stubAgent = {
      model: { name: "stub-model", modelId: "stub-model" },
      tools: [],
      toolRegistry: { list: () => [] },
      stream: makeAgentResultStream(buildAgentResult(interrupts)) as never,
    };
    const sa = new StrandsAgent({ agent: stubAgent as never, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    const events = await collect(sa);
    const finished = events.at(-1) as BaseEvent & {
      outcome?: { type: string; interrupts?: unknown[] };
    };
    const first = finished.outcome?.interrupts?.[0] as {
      metadata?: { reason?: unknown };
    };
    expect(first.metadata?.reason).toEqual({ question: "Which environment?" });
  });

  it("still classifies an ag_ui:tool_call:-named interrupt as a tool-call approval", async () => {
    // Sanity check: the ag_ui:tool_call: naming convention still produces
    // the tool-approval shape, unaffected by the generic path above.
    const interrupts = [
      {
        id: "int-4",
        name: "ag_ui:tool_call:confirm_delete",
        reason: {
          tool_call: true,
          tool_name: "confirm_delete",
          tool_input: {},
          tool_use_id: "int-4",
        },
      } as unknown as StrandsInterrupt,
    ];
    const stubAgent = {
      model: { name: "stub-model", modelId: "stub-model" },
      tools: [],
      toolRegistry: { list: () => [] },
      stream: makeAgentResultStream(buildAgentResult(interrupts)) as never,
    };
    const sa = new StrandsAgent({ agent: stubAgent as never, name: "t" });
    (
      sa as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread.set("thread-1", stubAgent);

    const events = await collect(sa);
    const finished = events.at(-1) as BaseEvent & {
      outcome?: { type: string; interrupts?: unknown[] };
    };
    const first = finished.outcome?.interrupts?.[0] as {
      reason: string;
      responseSchema?: unknown;
    };
    expect(first.reason).toBe("tool_call");
    expect(first.responseSchema).toBeDefined();
  });
});
