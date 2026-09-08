/**
 * Unit tests for StrandsAgent.
 *
 * We don't spin up a full Strands Agent — instead we inject a stub that
 * yields a scripted sequence of events whose `type` discriminators match
 * what `@strands-agents/sdk`'s `Agent.stream()` produces. This keeps tests
 * fast and hermetic and avoids needing a model provider.
 */

import { describe, it, expect, vi } from "vitest";
import {
  DocumentBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
  VideoBlock,
} from "@strands-agents/sdk";
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

  it("reports a TypeError thrown inside the SDK stream as a fault from outside", async () => {
    // An integrator's tool throws the same types a defect in this adapter
    // does, and everything Strands runs for the adapter throws past the same
    // boundary, so `ADAPTER_BUG` cannot be claimed for what arrives there. It
    // is not a case of its own either: Strands caught it mid-cycle, which is
    // the forced stop, and it reports under the same code as the neighbouring
    // failure above.
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
      message: string;
    };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe("STRANDS_FORCE_STOP");
    expect(last.message).toBe("cannot read property 'foo' of undefined");
  });

  it("still reports a defect in the adapter's own translation as ADAPTER_BUG", async () => {
    // The regression guard for the boundary above: it must not have turned
    // every TypeError into somebody else's. This one is thrown while the
    // adapter reads an event it has already taken off the stream, which is its
    // own code running and so is exactly what `ADAPTER_BUG` claims.
    const hostileEvent = {} as AgentStreamEvent;
    Object.defineProperty(hostileEvent, "type", {
      get() {
        throw new TypeError("event kind is not readable");
      },
    });
    const agent = scriptedStrandsAgent([hostileEvent]);

    const events = await collectQuietly(agent);
    const last = events[events.length - 1] as unknown as {
      type: string;
      code: string;
    };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe("ADAPTER_BUG");
  });

  it("reports an unserializable tool result as a fault from outside", async () => {
    // `JSON.stringify` throws over a BigInt and over a structure that refers
    // back to itself, both of which an integrator's tool can return without
    // noticing. The tool wrote the value, so the contract to fix is the
    // tool's. This is the case the Python sibling reaches through
    // `json.dumps`.
    const circular: Record<string, unknown> = { name: "node" };
    circular.self = circular;
    const agent = scriptedStrandsAgent([
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "backend-1", name: "backend_tool", input: {} },
        tool: undefined,
        result: { content: [{ json: circular }] },
      } as unknown as AgentStreamEvent,
    ]);

    const events = await collectQuietly(agent);
    const last = events[events.length - 1] as unknown as {
      type: string;
      code: string;
      message: string;
    };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe("STRANDS_ERROR");
    expect(last.message).toContain("not JSON serializable");
  });

  it("keeps the original serialization failure as the reported fault's cause", async () => {
    // The wrapper's contract, and what Python's `raise ... from exc` gives an
    // operator: the stack that reaches the log names where serialization
    // actually failed. Wrapping a freshly built Error instead leaves a `cause`
    // whose stack starts in the wrapper.
    const circular: Record<string, unknown> = { name: "node" };
    circular.self = circular;
    const agent = scriptedStrandsAgent([
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "backend-1", name: "backend_tool", input: {} },
        tool: undefined,
        result: { content: [{ json: circular }] },
      } as unknown as AgentStreamEvent,
    ]);

    // The failure OBJECT, not its text: only the object carries `cause`.
    const logged: unknown[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    try {
      await collect(agent, minimalRunInput());
    } finally {
      spy.mockRestore();
    }

    const fault = logged.find(
      (a): a is Error => a instanceof Error && a.name === "ForeignFault",
    );
    expect(fault).toBeDefined();
    expect(fault!.message).toContain("not JSON serializable");
    expect(fault!.cause).toBeInstanceOf(TypeError);
    expect((fault!.cause as Error).message).toContain("circular");
  });

  it.each([
    ["a scalar", "not an object"],
    ["an array", ["not", "an", "object"]],
  ])("emits no initial snapshot for %s state", async (_label, state) => {
    // AG-UI types `state` as any value, so a scalar is a run and not a
    // failure. It is not an initial STATE_SNAPSHOT either: filtering
    // `messages` out is a keyed object's concern only, and taking an array
    // through that filter put an index-keyed object on the wire that no
    // client asked for. Python emits nothing here, so nothing is what a
    // non-object gets.
    const agent = scriptedStrandsAgent([]);
    const events = await collect(agent, minimalRunInput({ state }));

    const kinds = types(events);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    const snapshots = events
      .filter((e) => e.type === EventType.STATE_SNAPSHOT)
      .map((e) => (e as unknown as { snapshot: unknown }).snapshot);
    // Only the terminal snapshot, which tracks the key/value merges tools
    // publish and so starts empty for a state that carries none of them.
    expect(snapshots).toEqual([{}]);
  });

  it("propagates a TypeError thrown after pendingHalt was set (M4)", async () => {
    // pendingHalt is set when a frontend tool fires; the surrounding `for await`
    // historically swallowed any post-halt stream error as the expected
    // "Stream ended" sentinel. TypeError/ReferenceError must escape that
    // sentinel handling: the sentinel is identified by shape, and one of these
    // can wear it, so a real failure would otherwise finish the run. Escaping
    // the swallow is all that check does; the failure is reported as the
    // forced stop like any other out of the same call.
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
    expect(error!.code).toBe("STRANDS_FORCE_STOP");
    expect(types(events)).not.toContain(EventType.RUN_FINISHED);
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

  it.each([
    [
      "image",
      [
        new ImageBlock({
          format: "png",
          source: { bytes: new Uint8Array([0, 1]) },
        }),
      ],
      {
        image: { format: "png", source: { bytes: "AAE=" } },
      },
    ],
    [
      "document",
      [
        new DocumentBlock({
          name: "result.pdf",
          format: "pdf",
          source: { bytes: new Uint8Array([2, 3]) },
        }),
      ],
      {
        document: {
          name: "result.pdf",
          format: "pdf",
          source: { bytes: "AgM=" },
        },
      },
    ],
    [
      "video",
      [
        new VideoBlock({
          format: "mp4",
          source: { bytes: new Uint8Array([4, 5]) },
        }),
      ],
      {
        video: { format: "mp4", source: { bytes: "BAU=" } },
      },
    ],
    [
      "multiple blocks",
      [
        new ImageBlock({
          format: "png",
          source: { bytes: new Uint8Array([0, 1]) },
        }),
        new DocumentBlock({
          name: "result.pdf",
          format: "pdf",
          source: { bytes: new Uint8Array([2, 3]) },
        }),
      ],
      [
        { image: { format: "png", source: { bytes: "AAE=" } } },
        {
          document: {
            name: "result.pdf",
            format: "pdf",
            source: { bytes: "AgM=" },
          },
        },
      ],
    ],
  ])(
    "serializes %s backend tool results",
    async (_kind, contentBlocks, expected) => {
      const toolUseId = `backend-${_kind}`;
      const block = new ToolUseBlock({
        name: "backend_tool",
        toolUseId,
        input: {},
      });
      const resultBlock = new ToolResultBlock({
        toolUseId,
        status: "success",
        content: contentBlocks,
      });
      const agent = scriptedStrandsAgent([
        block as unknown as AgentStreamEvent,
        {
          type: "afterToolCallEvent",
          toolUse: {
            toolUseId,
            name: "backend_tool",
            input: {},
          },
          tool: undefined,
          result: resultBlock,
        } as unknown as AgentStreamEvent,
      ]);

      const events = await collect(agent);
      const result = events.find(
        (event) => event.type === EventType.TOOL_CALL_RESULT,
      ) as unknown as { content: string };

      expect(result).toBeDefined();
      expect(JSON.parse(result.content)).toEqual(expected);
    },
  );

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
