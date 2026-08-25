/**
 * Unit tests for StrandsAgent.
 *
 * We don't spin up a full Strands Agent — instead we inject a stub that
 * yields a scripted sequence of events whose `type` discriminators match
 * what `@strands-agents/sdk`'s `Agent.stream()` produces. This keeps tests
 * fast and hermetic and avoids needing a model provider.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolUseBlock, ToolResultBlock, TextBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { BaseEvent } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import {
  collect,
  minimalRunInput,
  scriptedAgent,
  scriptedStrandsAgent,
  stream,
} from "./helpers";
import type { RunAgentInput } from "@ag-ui/core";

function types(events: BaseEvent[]): string[] {
  return events.map((e) => e.type);
}

/**
 * Run with the adapter's expected error logging captured instead of printed.
 *
 * `try`/`finally` because a rejecting run would otherwise skip the restore and
 * leave `console.error` mocked for every test after it in this file, silencing
 * failures that have nothing to do with the one that threw.
 */
async function collectQuietly(
  agent: StrandsAgent,
  input?: RunAgentInput,
): Promise<BaseEvent[]> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await collect(agent, input ?? minimalRunInput());
  } finally {
    spy.mockRestore();
  }
}

describe("StrandsAgent.run — lifecycle", () => {
  it("emits RUN_STARTED + STATE_SNAPSHOT(s) + RUN_FINISHED for an empty stream", async () => {
    const agent = scriptedStrandsAgent([]);
    const events = await collect(agent);
    // Initial snapshot is always emitted when state is provided (even {}),
    // plus the final snapshot before RUN_FINISHED. This matches Python's
    // behavior so a client that wires the initial snapshot's state onto
    // its UI doesn't diverge if the server later updates the state.
    const kinds = types(events);
    expect(kinds[0]).toBe(EventType.RUN_STARTED);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(
      kinds.filter((k) => k === EventType.STATE_SNAPSHOT).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("filters `messages` out of the INITIAL state snapshot but keeps it in the FINAL (Py parity)", async () => {
    const agent = scriptedStrandsAgent([]);
    const input = minimalRunInput({
      state: { foo: "bar", messages: [{ role: "user", content: "x" }] },
    });
    const events = await collect(agent, input);
    const stateEvents = events.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );
    expect(stateEvents).toHaveLength(2);
    // Initial snapshot filters `messages` (frontend doesn't recognize role="tool").
    const initial = (
      stateEvents[0] as unknown as {
        snapshot: Record<string, unknown>;
      }
    ).snapshot;
    expect(initial).not.toHaveProperty("messages");
    expect(initial).toHaveProperty("foo", "bar");
    // Final snapshot preserves `messages` verbatim — matches Py adapter.
    const final = (
      stateEvents[1] as unknown as {
        snapshot: Record<string, unknown>;
      }
    ).snapshot;
    expect(final).toHaveProperty("messages");
    expect(final).toHaveProperty("foo", "bar");
  });

  it("emits RUN_ERROR with STRANDS_FORCE_STOP code when the stream throws", async () => {
    // The TS SDK has no ForceStopEvent, so a failed model cycle escapes
    // `agent.stream()` as a throw. The throw is therefore the forced stop, and
    // it reports under the code and message Python's `force_stop` branch uses.
    const agent = scriptedStrandsAgent([], {
      stubOverrides: {
        stream: async function* () {
          throw new Error("boom");
        } as unknown as import("@strands-agents/sdk").Agent["stream"],
      },
    });
    // The forced-stop path logs `error(prefix, e)` by design; capture it the
    // way the neighbouring code-defect test does so the expected line does not
    // reach the test output.
    const events = await collectQuietly(agent);
    const last = events[events.length - 1] as unknown as {
      type: string;
      code: string;
      message: string;
    };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe("STRANDS_FORCE_STOP");
    expect(last.message).toBe("boom");
  });

  it("classifies TypeError thrown during run as ADAPTER_BUG (code defect)", async () => {
    // STRANDS_FORCE_STOP is reserved for SDK/provider failures (Bedrock
    // throttling, upstream 5xx). TypeError/ReferenceError indicate the adapter
    // itself is broken. Distinguishing the two lets operators tell "fix our
    // code" from "retry against the SDK".
    const agent = scriptedStrandsAgent([], {
      stubOverrides: {
        stream: async function* () {
          throw new TypeError("cannot read property 'foo' of undefined");
        } as unknown as import("@strands-agents/sdk").Agent["stream"],
      },
    });
    const events = await collectQuietly(agent);
    const last = events[events.length - 1] as unknown as {
      type: string;
      code: string;
    };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe("ADAPTER_BUG");
  });

  it("propagates a TypeError thrown after pendingHalt was set (M4)", async () => {
    // pendingHalt is set when a frontend tool fires; the surrounding `for await`
    // historically swallowed any post-halt stream error as the expected
    // "Stream ended" sentinel. TypeError/ReferenceError must escape that
    // sentinel handling because they indicate code defects, not the normal
    // halt-on-frontend-tool path.
    const stub = scriptedAgent([], {
      stream: async function* () {
        // Frontend tool sets pendingHalt …
        yield {
          type: "modelContentBlockStartEvent",
          start: {
            type: "toolUseStart",
            name: "frontend_tool",
            toolUseId: "tc1",
          },
        } as unknown as AgentStreamEvent;
        yield {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "toolUseInputDelta", input: '{"x":1}' },
        } as unknown as AgentStreamEvent;
        yield {
          type: "modelContentBlockStopEvent",
        } as unknown as AgentStreamEvent;
        // … then an adapter bug throws.
        throw new TypeError("cannot read property 'foo' of undefined");
      } as unknown as import("@strands-agents/sdk").Agent["stream"],
    });
    const agent = new StrandsAgent({ agent: stub, name: "t" });
    const byThread = (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    byThread.set("thread-1", stub);
    byThread.set("default", stub);
    const events = await collectQuietly(
      agent,
      minimalRunInput({
        tools: [
          {
            name: "frontend_tool",
            description: "",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );
    const error = events.find((e) => e.type === EventType.RUN_ERROR) as
      | { code: string }
      | undefined;
    expect(error).toBeTruthy();
    expect(error!.code).toBe("ADAPTER_BUG");
  });
});

describe("StrandsAgent.run — text streaming", () => {
  it("wraps text deltas in TEXT_MESSAGE_START/_CONTENT/_END", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Hello"),
      stream.blockStop(),
    ]);
    const events = await collect(agent);
    const kinds = types(events);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_START);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_END);
    const content = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    ) as unknown as { delta: string };
    expect(content.delta).toBe("Hello");
  });

  it("unwraps Strands v1.0 ModelStreamUpdateEvent wrappers", async () => {
    // Real Strands v1.x yields hook-event wrappers that carry the inner
    // ModelStreamEvent on `.event`. The adapter unwraps these before
    // dispatching so the same codepath handles both wrapped and raw events.
    const agent = scriptedStrandsAgent([
      {
        type: "modelStreamUpdateEvent",
        event: {
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "wrapped" },
        },
      } as unknown as AgentStreamEvent,
      {
        type: "modelStreamUpdateEvent",
        event: { type: "modelContentBlockStopEvent" },
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);
    const content = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    ) as unknown as { delta: string };
    expect(content).toBeDefined();
    expect(content.delta).toBe("wrapped");
  });
});

describe("StrandsAgent.run — tool calls", () => {
  it("unwraps ContentBlockEvent wrappers around ToolUseBlock", async () => {
    // Strands v1.0 wraps completed content blocks in `ContentBlockEvent`
    // hook events. The adapter unwraps those so the same code path handles
    // both wrapped and raw ToolUseBlock values.
    const block = new ToolUseBlock({
      name: "get_weather",
      toolUseId: "strands-2",
      input: { city: "Seattle" },
    });
    const wrapped = {
      type: "contentBlockEvent",
      contentBlock: block,
    } as unknown as AgentStreamEvent;
    const agent = scriptedStrandsAgent([wrapped]);
    const events = await collect(agent);
    const start = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as unknown as { toolCallName: string; toolCallId: string };
    expect(start).toBeDefined();
    expect(start.toolCallName).toBe("get_weather");
    expect(start.toolCallId).toBe("strands-2");
  });

  it("emits TOOL_CALL_START/ARGS/END when a ToolUseBlock is yielded directly", async () => {
    const block = new ToolUseBlock({
      name: "get_weather",
      toolUseId: "strands-1",
      input: { city: "Portland" },
    });
    const agent = scriptedStrandsAgent([block as unknown as AgentStreamEvent]);
    const events = await collect(agent);
    const kinds = types(events);
    expect(kinds).toContain(EventType.TOOL_CALL_START);
    expect(kinds).toContain(EventType.TOOL_CALL_ARGS);
    expect(kinds).toContain(EventType.TOOL_CALL_END);

    const start = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as unknown as { toolCallName: string; toolCallId: string };
    expect(start.toolCallName).toBe("get_weather");
    expect(start.toolCallId).toBe("strands-1");

    const args = events.find(
      (e) => e.type === EventType.TOOL_CALL_ARGS,
    ) as unknown as { delta: string };
    expect(JSON.parse(args.delta)).toEqual({ city: "Portland" });
  });

  it("emits TOOL_CALL_RESULT for backend tool results (afterToolCallEvent)", async () => {
    const block = new ToolUseBlock({
      name: "backend_tool",
      toolUseId: "backend-1",
      input: { x: 1 },
    });
    const resultBlock = new ToolResultBlock({
      toolUseId: "backend-1",
      status: "success",
      content: [new TextBlock(JSON.stringify({ ok: true }))],
    });
    const agent = scriptedStrandsAgent([
      block as unknown as AgentStreamEvent,
      {
        type: "afterToolCallEvent",
        toolUse: {
          toolUseId: "backend-1",
          name: "backend_tool",
          input: { x: 1 },
        },
        tool: undefined,
        result: resultBlock,
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);
    const result = events.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as unknown as { toolCallId: string; content: string };
    expect(result).toBeDefined();
    expect(result.toolCallId).toBe("backend-1");
    expect(JSON.parse(result.content)).toEqual({ ok: true });
  });

  it("emits a PredictState CustomEvent when ToolBehavior.predictState is configured", async () => {
    const block = new ToolUseBlock({
      name: "set_recipe",
      toolUseId: "u-1",
      input: { name: "Soup" },
    });
    const agent = scriptedStrandsAgent([block as unknown as AgentStreamEvent]);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        set_recipe: {
          predictState: [
            { stateKey: "recipe", tool: "set_recipe", toolArgument: "data" },
          ],
        },
      },
    };
    const events = await collect(agent);
    const custom = events.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as unknown as { name: string }).name === "PredictState",
    ) as unknown as { value: unknown[] };
    expect(custom).toBeDefined();
    expect(custom.value).toEqual([
      { state_key: "recipe", tool: "set_recipe", tool_argument: "data" },
    ]);
  });
});

describe("StrandsAgent.run — reasoning", () => {
  it("emits REASONING_* events and closes on contentBlockStop", async () => {
    const agent = scriptedStrandsAgent([
      stream.reasoningDelta("thinking..."),
      stream.blockStop(),
    ]);
    const events = await collect(agent);
    const kinds = types(events);
    expect(kinds).toContain(EventType.REASONING_START);
    expect(kinds).toContain(EventType.REASONING_MESSAGE_START);
    expect(kinds).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(kinds).toContain(EventType.REASONING_MESSAGE_END);
    expect(kinds).toContain(EventType.REASONING_END);
  });

  it("base64-encodes redactedContent into REASONING_ENCRYPTED_VALUE", async () => {
    const agent = scriptedStrandsAgent([
      stream.reasoningRedacted(new Uint8Array([0x41, 0x42, 0x43])),
    ]);
    const events = await collect(agent);
    const enc = events.find(
      (e) => e.type === EventType.REASONING_ENCRYPTED_VALUE,
    ) as unknown as { encryptedValue: string };
    expect(enc).toBeDefined();
    expect(enc.encryptedValue).toBe("QUJD");
  });
});

describe("StrandsAgent.run — session-manager provider", () => {
  it("emits RUN_ERROR(SESSION_MANAGER_ERROR) if the provider throws", async () => {
    const stub = scriptedAgent([]);
    const agent = new StrandsAgent({
      agent: stub,
      name: "t",
      config: {
        sessionManagerProvider: () => {
          throw new Error("no session for you");
        },
      },
    });
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "fresh-thread" }),
    );
    const kinds = types(events);
    expect(kinds).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    const err = events[1] as unknown as { message: string; code: string };
    expect(err.code).toBe("SESSION_MANAGER_ERROR");
    expect(err.message).toContain("no session for you");
  });

  it("emits RUN_ERROR(SESSION_MANAGER_INVALID_TYPE) if the provider returns garbage", async () => {
    const stub = scriptedAgent([]);
    const agent = new StrandsAgent({
      agent: stub,
      name: "t",
      config: {
        // Empty object with no HookProvider shape.
        sessionManagerProvider: () => ({ unrelated: true }) as never,
      },
    });
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "fresh-thread-2" }),
    );
    const kinds = types(events);
    expect(kinds).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    expect((events[1] as unknown as { code: string }).code).toBe(
      "SESSION_MANAGER_INVALID_TYPE",
    );
  });
});

describe("StrandsAgent.run — state context builder", () => {
  it("lets the builder rewrite the prompt before it's forwarded to Strands", async () => {
    let capturedArgs: unknown = null;
    const stub = scriptedAgent([], {
      messages: [],
      stream: async function* (prompt: unknown) {
        capturedArgs = prompt;
      } as unknown as import("@strands-agents/sdk").Agent["stream"],
    });
    const agent = new StrandsAgent({ agent: stub, name: "test" });
    const byThread = (
      agent as unknown as { _agentsByThread: Map<string, unknown> }
    )._agentsByThread;
    byThread.set("thread-1", stub);
    byThread.set("default", stub);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: (_input: unknown, prompt: string) =>
        `${prompt} [STATE:ok]`,
    };

    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "m1", role: "user", content: "Hi there" }],
      }),
    );
    // History reconciliation moves the prompt onto agent.messages and the
    // adapter calls stream(undefined). The builder is applied to the last
    // user-text turn in the replayed history (Python parity).
    expect(capturedArgs).toBeUndefined();
    const replayed = (stub as unknown as { messages: unknown[] })
      .messages as Array<{
      role: string;
      content: Array<{ text?: string }>;
    }>;
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.content[0]!.text).toBe("Hi there [STATE:ok]");
  });
});
