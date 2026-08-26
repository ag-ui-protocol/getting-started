/**
 * `ToolBehavior.continueAfterFrontendCall = true` must keep the stream
 * alive after a frontend tool call completes. Without the flag, the
 * adapter sets `pendingHalt` after emitting TOOL_CALL_END and silences
 * subsequent events (including any trailing text). With the flag, the
 * adapter must NOT halt — subsequent text deltas should flow through to
 * the client.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolUseBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType, type RunAgentInput } from "@ag-ui/core";

import {
  collect,
  minimalRunInput,
  scriptedStrandsAgent,
  stream,
} from "./helpers";

/**
 * Run with the adapter's error logging captured instead of printed.
 *
 * The forced-stop path logs `error(prefix, e)` by design; leaving it on stderr
 * buries a real failure in expected noise.
 */
async function collectQuietly(
  agent: ReturnType<typeof scriptedStrandsAgent>,
  input?: RunAgentInput,
) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await collect(agent, input ?? minimalRunInput());
  } finally {
    spy.mockRestore();
  }
}

function frontendToolInput(): RunAgentInput {
  return minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "do a thing" }],
    tools: [
      {
        name: "set_color",
        description: "Sets a UI color.",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } },
          required: ["color"],
        },
      },
    ],
  });
}

/**
 * Realistic Strands stream shape for a frontend tool call:
 *   1. ToolUseBlock emitted for `set_color`
 *   2. afterToolCallEvent fires with Strands' placeholder proxy result
 *      ("Forwarded to client") — this is the signal that flips
 *      pendingHalt → haltEventStream when the flag is off.
 *   3. A text delta Strands would stream after the tool — should be
 *      suppressed in default halt mode, passed through with continue flag.
 */
const scriptedEvents: AgentStreamEvent[] = [
  new ToolUseBlock({
    name: "set_color",
    toolUseId: "fe-1",
    input: { color: "red" },
  }) as unknown as AgentStreamEvent,
  {
    type: "afterToolCallEvent",
    toolUse: { toolUseId: "fe-1", name: "set_color", input: { color: "red" } },
    tool: undefined,
    result: {
      toolUseId: "fe-1",
      status: "success",
      content: [{ text: "Forwarded to client" }],
    },
  } as unknown as AgentStreamEvent,
  stream.textDelta("after-tool"),
  stream.blockStop(),
];

describe("continueAfterFrontendCall", () => {
  it("default (halt): trailing text after a frontend tool call is suppressed", async () => {
    const agent = scriptedStrandsAgent(scriptedEvents);
    // No override — default is halt after frontend tool call.
    const events = await collect(agent, frontendToolInput());
    const k = events.map((e) => e.type);
    expect(k).toContain(EventType.TOOL_CALL_START);
    expect(k).toContain(EventType.TOOL_CALL_END);
    // Trailing text MUST NOT reach the client.
    const content = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(content).not.toContain("after-tool");
  });

  it("continueAfterFrontendCall=true: trailing text IS delivered to the client", async () => {
    const agent = scriptedStrandsAgent(scriptedEvents);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        set_color: { continueAfterFrontendCall: true },
      },
    };
    const events = await collect(agent, frontendToolInput());
    const k = events.map((e) => e.type);
    expect(k).toContain(EventType.TOOL_CALL_END);
    const content = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(content).toContain("after-tool");
  });

  it("swallows 'Stream ended without completing a message' when halting from a frontend tool call", async () => {
    // Strands v1.0+ raises when the agent loop halts before a final
    // assistant message is produced. Our adapter should treat that as a
    // clean end-of-stream (not RUN_ERROR) as long as we've already
    // decided to halt because of a frontend tool call.
    //
    // The frontend tool call alone arms the halt, and nothing follows it: an
    // `afterToolCallEvent` breaks the consume loop outright, so a throw
    // scripted after one is never reached and the swallow is never driven.
    // The window this test is about is the one in between, halt armed and the
    // SDK raising before its after-call event arrives, which is exactly how a
    // halted Strands cycle behaves.
    const block = new ToolUseBlock({
      name: "set_color",
      toolUseId: "fe-99",
      input: { color: "red" },
    });
    const agent = scriptedStrandsAgent([], {
      stubOverrides: {
        stream: async function* () {
          yield block as unknown as AgentStreamEvent;
          throw new Error("Stream ended without completing a message");
        } as unknown as import("@strands-agents/sdk").Agent["stream"],
      },
    });
    const events = await collect(agent, frontendToolInput());
    const k = events.map((e) => e.type);
    expect(k).toContain(EventType.TOOL_CALL_START);
    expect(k).toContain(EventType.TOOL_CALL_END);
    expect(k).not.toContain(EventType.RUN_ERROR);
    expect(k[k.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("continueAfterFrontendCall=true still skips TOOL_CALL_RESULT for frontend tools", async () => {
    // Even when we don't halt, the frontend tool's placeholder result from
    // the Strands proxy must not be emitted — the real result comes from
    // the client on the next run.
    const events: AgentStreamEvent[] = [
      new ToolUseBlock({
        name: "set_color",
        toolUseId: "fe-2",
        input: { color: "blue" },
      }) as unknown as AgentStreamEvent,
      // afterToolCallEvent for the frontend tool — Strands' proxy produces
      // a placeholder "Forwarded to client" result that must be suppressed.
      {
        type: "afterToolCallEvent",
        toolUse: {
          toolUseId: "fe-2",
          name: "set_color",
          input: { color: "blue" },
        },
        tool: undefined,
        result: {
          toolUseId: "fe-2",
          status: "success",
          content: [{ text: "Forwarded to client" }],
        },
      } as unknown as AgentStreamEvent,
    ];
    const agent = scriptedStrandsAgent(events);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        set_color: { continueAfterFrontendCall: true },
      },
    };
    const collected = await collect(agent, frontendToolInput());
    const k = collected.map((e) => e.type);
    expect(k).not.toContain(EventType.TOOL_CALL_RESULT);
    expect(k).toContain(EventType.TOOL_CALL_END);
  });

  it("DOES surface RUN_ERROR when the stream throws WITHOUT a prior halt signal", async () => {
    // Tightness check: the stream-end swallow added for frontend-halt
    // parity (agent.ts `if (pendingHalt || haltEventStream)`) must NOT
    // mask real model failures. Stream throws outside a halt context →
    // RUN_ERROR must flow back to the client. A provider failure escaping
    // the Strands stream is this bridge's forced stop, so it carries the
    // code Python reports one under.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: {
        stream: async function* () {
          throw new Error("Bedrock upstream 500: internal server error");
        } as unknown as import("@strands-agents/sdk").Agent["stream"],
      },
    });
    const events = await collectQuietly(agent);
    const k = events.map((e) => e.type);
    const err = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as unknown as { code?: string; message?: string } | undefined;
    expect(err).toBeDefined();
    expect(err?.code).toBe("STRANDS_FORCE_STOP");
    expect(err?.message).toContain("Bedrock upstream 500");
    // And no false RUN_FINISHED — the error is the terminator.
    expect(k[k.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("surfaces RUN_ERROR when the stream throws with the Strands 'Stream ended' message but no pending halt", async () => {
    // Also make sure we're not doing a naive string match on the error
    // message — the swallow must only fire when the halt flags are set,
    // regardless of what the thrown message says.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: {
        stream: async function* () {
          // Same error text that triggers the halt-swallow in the earlier
          // test, but this time no frontend tool call / no halt flag.
          throw new Error("Stream ended without completing a message");
        } as unknown as import("@strands-agents/sdk").Agent["stream"],
      },
    });
    // No frontend tools advertised — adapter has no reason to halt.
    const events = await collectQuietly(agent);
    const err = events.find((e) => e.type === EventType.RUN_ERROR);
    expect(err).toBeDefined();
    expect((err as unknown as { code?: string }).code).toBe(
      "STRANDS_FORCE_STOP",
    );
  });
});
