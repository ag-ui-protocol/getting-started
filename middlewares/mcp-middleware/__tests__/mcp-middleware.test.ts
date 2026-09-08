import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  Tool,
} from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";

// --- Mock the MCP SDK ---------------------------------------------------------
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = mockConnect;
    close = mockClose;
    listTools = mockListTools;
    callTool = mockCallTool;
  },
}));
const sseTransportCalls: Array<{ url: URL; opts: unknown }> = [];
const httpTransportCalls: Array<{ url: URL; opts: unknown }> = [];

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(public url: URL, public opts?: unknown) {
      sseTransportCalls.push({ url, opts });
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(public url: URL, public opts?: unknown) {
      httpTransportCalls.push({ url, opts });
    }
  },
}));

import { MCPMiddleware } from "../src/index";

// --- Event builders (real streaming events; no MESSAGES_SNAPSHOT) -------------
const THREAD = "t";

function runStarted(runId = "r"): BaseEvent {
  return { type: EventType.RUN_STARTED, threadId: THREAD, runId } as BaseEvent;
}
function runFinished(runId = "r"): BaseEvent {
  return { type: EventType.RUN_FINISHED, threadId: THREAD, runId } as BaseEvent;
}
function runError(message = "boom"): BaseEvent {
  return { type: EventType.RUN_ERROR, message } as BaseEvent;
}

/** Streaming events for one assistant tool call. `args` may be split into
 *  multiple deltas to simulate chunked argument streaming. */
function toolCall(
  toolCallId: string,
  toolCallName: string,
  args: string | string[] = "{}",
): BaseEvent[] {
  const deltas = Array.isArray(args) ? args : [args];
  return [
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName } as BaseEvent,
    ...deltas.map(
      (delta) =>
        ({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta }) as BaseEvent,
    ),
    { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent,
  ];
}

function textMessage(messageId: string, text: string): BaseEvent[] {
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
  ];
}

// --- Mock agents --------------------------------------------------------------
/** Replays a different batch of events on each successive run() call. */
class BatchMockAgent extends AbstractAgent {
  public runCalls: RunAgentInput[] = [];
  private call = 0;
  constructor(private batches: BaseEvent[][]) {
    super();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runCalls.push(input);
    const events = this.batches[this.call] ?? [runStarted(), runFinished()];
    this.call++;
    return new Observable((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

/**
 * Emits a fresh batch on every run — the factory receives the run index
 * so it can mint unique ids per iteration (a real looping agent never
 * re-emits the same tool-call id, and the middleware now syncs prior
 * results into `agent.messages`, which would resolve a re-used id). Used
 * to exercise the runaway guard.
 */
class LoopingMockAgent extends AbstractAgent {
  public runCount = 0;
  constructor(private eventsFor: (run: number) => BaseEvent[]) {
    super();
  }
  run(): Observable<BaseEvent> {
    const events = this.eventsFor(this.runCount);
    this.runCount++;
    return new Observable((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

/**
 * Decides what to emit based on its OWN `this.messages` (the downstream
 * agent's persistent state) — mirroring how `defaultApplyEvents` seeds the
 * apply chain from `agent.messages`, not from `input.messages`. While a
 * matching tool call sits unresolved in `this.messages` it keeps re-emitting
 * it; once a `role: "tool"` result is present it produces a final text
 * answer. This is the only mock that reproduces the coupling the middleware's
 * `next.messages.push(...)` defends against: if that sync is removed, the
 * result never lands in `this.messages` and this agent loops forever
 * (re-emitting the same call) instead of terminating after one execution.
 */
class StatefulMockAgent extends AbstractAgent {
  public runCount = 0;
  constructor(private toolCallName: string) {
    super();
  }
  run(): Observable<BaseEvent> {
    this.runCount++;
    const resolved = this.messages.some((m) => m.role === "tool");
    const events = resolved
      ? [runStarted(`r${this.runCount}`), ...textMessage("m", "done"), runFinished(`r${this.runCount}`)]
      : [runStarted(`r${this.runCount}`), ...toolCall("c1", this.toolCallName), runFinished(`r${this.runCount}`)];
    return new Observable((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

function createRunAgentInput(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: THREAD,
    runId: "r",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
    ...overrides,
  };
}

async function collectEvents(o: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return firstValueFrom(o.pipe(toArray()));
}

const weatherServer = (): { type: "http"; url: string; serverId: string } => ({
  type: "http",
  url: "https://example.com/mcp",
  serverId: "s",
});

beforeEach(() => {
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockClose.mockReset().mockResolvedValue(undefined);
  mockListTools.mockReset().mockResolvedValue({ tools: [] });
  mockCallTool
    .mockReset()
    .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  sseTransportCalls.length = 0;
  httpTransportCalls.length = 0;
});

// --- Tool injection -----------------------------------------------------------
describe("MCPMiddleware — tool injection", () => {
  async function injectedNames(
    middleware: MCPMiddleware,
    input: RunAgentInput,
  ): Promise<string[]> {
    const next = new BatchMockAgent([[runStarted(), runFinished()]]);
    await collectEvents(middleware.run(input, next));
    return next.runCalls[0].tools.map((t) => t.name);
  }

  it("passes through untouched with no servers", async () => {
    const names = await injectedNames(new MCPMiddleware(), createRunAgentInput());
    expect(names).toEqual([]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("prefixes injected tools as mcp__{server}__{tool}", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "list_issues", inputSchema: {} }] });
    const names = await injectedNames(
      new MCPMiddleware([{ ...weatherServer(), serverId: "github" }]),
      createRunAgentInput(),
    );
    expect(names).toEqual(["mcp__github__list_issues"]);
  });

  it("falls back to server{index} without serverId", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "ping", inputSchema: {} }] });
    const names = await injectedNames(
      new MCPMiddleware([{ type: "http", url: "https://example.com/mcp" }]),
      createRunAgentInput(),
    );
    expect(names).toEqual(["mcp__server0__ping"]);
  });

  it("merges MCP tools after existing input tools", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "ping", inputSchema: {} }] });
    const existing: Tool = { name: "existing", description: "", parameters: {} };
    const names = await injectedNames(
      new MCPMiddleware([weatherServer()]),
      createRunAgentInput({ tools: [existing] }),
    );
    expect(names).toEqual(["existing", "mcp__s__ping"]);
  });

  it("dedupes colliding names", async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: "dup", inputSchema: {} }, { name: "dup", inputSchema: {} }],
    });
    const names = await injectedNames(
      new MCPMiddleware([weatherServer()]),
      createRunAgentInput(),
    );
    expect(names).toEqual(["mcp__s__dup", "mcp__s__dup_1"]);
  });

  it("truncates names to 64 characters", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "t".repeat(80), inputSchema: {} }] });
    const names = await injectedNames(
      new MCPMiddleware([weatherServer()]),
      createRunAgentInput(),
    );
    expect(names[0].length).toBe(64);
  });

  it("skips a server that fails to list, keeping the others", async () => {
    mockListTools
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ tools: [{ name: "ok", inputSchema: {} }] });
    const names = await injectedNames(
      new MCPMiddleware([
        { type: "http", url: "https://bad/mcp", serverId: "bad" },
        { type: "http", url: "https://good/mcp", serverId: "good" },
      ]),
      createRunAgentInput(),
    );
    expect(names).toEqual(["mcp__good__ok"]);
  });
});

// --- Execution loop -----------------------------------------------------------
describe("MCPMiddleware — execution loop", () => {
  it("does not interfere when no MCP tool calls are open", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [runStarted(), ...textMessage("m1", "hi"), runFinished()],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(next.runCalls).toHaveLength(1);
    expect(received.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("ignores a call that matches the prefix but is not a known MCP tool", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__ghost"), runFinished()],
    ]);
    await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(next.runCalls).toHaveLength(1);
  });

  it("scenario 1: executes our tool, emits result, then runs again", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "sunny" }] });
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__weather", '{"city":"sf"}'), runFinished()],
      [runStarted("r2"), ...textMessage("m2", "It is sunny."), runFinished("r2")],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "weather",
      arguments: { city: "sf" },
    });
    const result = received.find((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect((result as unknown as { content: string }).content).toBe("sunny");
    expect(next.runCalls).toHaveLength(2);
    expect(next.runCalls[1].messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("scenario 2: stops when a non-MCP tool call is still open", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [
        runStarted(),
        ...toolCall("c1", "mcp__s__weather"),
        ...toolCall("c2", "frontendTool"),
        runFinished(),
      ],
      [runStarted("r2"), runFinished("r2")],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(next.runCalls).toHaveLength(1);
    expect(received.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toHaveLength(1);
  });

  it("assembles tool-call arguments streamed across multiple chunks", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__weather", ['{"ci', 'ty":', '"sf"}']), runFinished()],
      [runStarted("r2"), ...textMessage("m2", "done"), runFinished("r2")],
    ]);
    await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "weather",
      arguments: { city: "sf" },
    });
  });

  it("loops multiple hops until no MCP calls remain", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__weather"), runFinished()],
      [runStarted("r2"), ...toolCall("c2", "mcp__s__weather"), runFinished("r2")],
      [runStarted("r3"), ...textMessage("m3", "finally done"), runFinished("r3")],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(mockCallTool).toHaveBeenCalledTimes(2);
    expect(next.runCalls).toHaveLength(3);

    // Single-run presentation must hold across TWO hops (3 inner runs): the
    // consumer sees exactly one RUN_STARTED and one RUN_FINISHED, and both
    // tool results land before that single terminal RUN_FINISHED.
    const types = received.map((e) => e.type);
    expect(types.filter((t) => t === EventType.RUN_STARTED)).toHaveLength(1);
    expect(types.filter((t) => t === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    const lastResult = types.lastIndexOf(EventType.TOOL_CALL_RESULT);
    expect(lastResult).toBeGreaterThan(-1);
    expect(lastResult).toBeLessThan(types.length - 1); // before the RUN_FINISHED
  });

  it("syncs tool results into agent.messages so a state-seeded agent terminates", async () => {
    // StatefulMockAgent emits based on its own `this.messages` (like the real
    // apply chain). It only stops re-emitting the tool call once a tool result
    // is present in those messages — which only happens because the middleware
    // pushes results into `next.messages`. If that sync regresses, this agent
    // loops to maxIterations instead of executing exactly once.
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "sunny" }] });
    const next = new StatefulMockAgent("mcp__s__weather");
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()], { maxIterations: 10 }).run(
        createRunAgentInput(),
        next,
      ),
    );
    expect(mockCallTool).toHaveBeenCalledTimes(1); // not maxIterations
    expect(next.runCount).toBe(2); // tool round + final text round
    const types = received.map((e) => e.type);
    expect(types.filter((t) => t === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(received.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(true);
  });

  it("executes multiple MCP calls in one round, surfacing per-call failures", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    mockCallTool
      .mockResolvedValueOnce({ content: [{ type: "text", text: "sunny" }] })
      .mockRejectedValueOnce(new Error("server exploded"));
    const next = new BatchMockAgent([
      [
        runStarted(),
        ...toolCall("c1", "mcp__s__weather"),
        ...toolCall("c2", "mcp__s__weather"),
        runFinished(),
      ],
      [runStarted("r2"), ...textMessage("m2", "ok"), runFinished("r2")],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    const results = received.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(2);
    const contents = results.map((r) => (r as unknown as { content: string }).content);
    expect(contents).toContain("sunny");
    expect(contents.some((c) => c.includes("Error executing tool weather"))).toBe(true);
    expect(next.runCalls).toHaveLength(2); // still looped — failures don't block
  });

  it("stringifies non-text tool results", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    mockCallTool.mockResolvedValue({
      content: [{ type: "image", data: "base64..." }],
    });
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__weather"), runFinished()],
      [runStarted("r2"), runFinished("r2")],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    const result = received.find((e) => e.type === EventType.TOOL_CALL_RESULT);
    const content = (result as unknown as { content: string }).content;
    expect(content).toContain("image");
  });

  it("stops at maxIterations instead of looping forever", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // This agent ALWAYS emits a fresh unresolved MCP tool call.
    const next = new LoopingMockAgent((n) => [
      runStarted(),
      ...toolCall(`c${n}`, "mcp__s__weather"),
      runFinished(),
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()], { maxIterations: 3 }).run(
        createRunAgentInput(),
        next,
      ),
    );
    expect(mockCallTool).toHaveBeenCalledTimes(3);
    // 3 execution rounds → 4 agent runs (the 4th detects the cap and stops).
    expect(next.runCount).toBe(4);
    expect(warn).toHaveBeenCalled();
    // Hitting the cap must still flush a terminal RUN_FINISHED — a consumer
    // waiting on it would otherwise hang.
    const types = received.map((e) => e.type);
    expect(types.filter((t) => t === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    warn.mockRestore();
  });

  it("does not execute tools when the run errors", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__weather"), runError("kaboom")],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(next.runCalls).toHaveLength(1);
    expect(received.some((e) => e.type === EventType.RUN_ERROR)).toBe(true);
  });

  it("stops the loop when the subscription is cancelled mid-execution", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    let releaseCall: (v: unknown) => void = () => {};
    mockCallTool.mockImplementation(
      () => new Promise((resolve) => (releaseCall = resolve)),
    );
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__weather"), runFinished()],
      [runStarted("r2"), runFinished("r2")],
    ]);
    const received: BaseEvent[] = [];
    const sub = new MCPMiddleware([weatherServer()])
      .run(createRunAgentInput(), next)
      .subscribe((e) => received.push(e));

    // Wait until execution is in-flight (callTool invoked), then cancel.
    await vi.waitFor(() => expect(mockCallTool).toHaveBeenCalledTimes(1));
    sub.unsubscribe();
    releaseCall({ content: [{ type: "text", text: "late" }] });
    await new Promise((r) => setTimeout(r, 10));

    expect(received.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(false);
    expect(next.runCalls).toHaveLength(1); // never looped
  });
});

// --- Headers + listTools caching ----------------------------------------------
describe("MCPMiddleware — headers + caching", () => {
  it("passes config headers to the streamable HTTP transport", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([[runStarted(), runFinished()]]);
    await collectEvents(
      new MCPMiddleware([
        {
          type: "http",
          url: "https://example.com/mcp",
          serverId: "s",
          headers: {
            Authorization: "Bearer abc",
            "X-Cpki-User-Id": "user-1",
          },
        },
      ]).run(createRunAgentInput(), next),
    );
    expect(httpTransportCalls).toHaveLength(1);
    expect(httpTransportCalls[0].opts).toEqual({
      requestInit: {
        headers: { Authorization: "Bearer abc", "X-Cpki-User-Id": "user-1" },
      },
    });
  });

  it("omits transport options when no headers are configured", async () => {
    mockListTools.mockResolvedValue({ tools: [] });
    const next = new BatchMockAgent([[runStarted(), runFinished()]]);
    await collectEvents(
      new MCPMiddleware([
        { type: "http", url: "https://example.com/mcp", serverId: "s" },
      ]).run(createRunAgentInput(), next),
    );
    expect(httpTransportCalls).toHaveLength(1);
    expect(httpTransportCalls[0].opts).toBeUndefined();
  });

  it("also passes headers to the SSE transport", async () => {
    mockListTools.mockResolvedValue({ tools: [] });
    const next = new BatchMockAgent([[runStarted(), runFinished()]]);
    await collectEvents(
      new MCPMiddleware([
        {
          type: "sse",
          url: "https://example.com/sse",
          serverId: "s",
          headers: { Authorization: "Bearer xyz" },
        },
      ]).run(createRunAgentInput(), next),
    );
    expect(sseTransportCalls).toHaveLength(1);
    expect(sseTransportCalls[0].opts).toEqual({
      requestInit: { headers: { Authorization: "Bearer xyz" } },
    });
  });

  it("lists tools only once per middleware instance, across runs", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const middleware = new MCPMiddleware([weatherServer()]);

    const first = new BatchMockAgent([[runStarted(), runFinished()]]);
    await collectEvents(middleware.run(createRunAgentInput(), first));

    const second = new BatchMockAgent([[runStarted("r2"), runFinished("r2")]]);
    await collectEvents(middleware.run(createRunAgentInput({ runId: "r2" }), second));

    expect(mockListTools).toHaveBeenCalledTimes(1);
    // The second run still received the cached tool injected.
    expect(second.runCalls[0].tools.map((t) => t.name)).toContain("mcp__s__weather");
  });

  it("does not retry a failed listing on the second run", async () => {
    mockListTools.mockRejectedValue(new Error("listing died"));
    const middleware = new MCPMiddleware([weatherServer()]);

    const first = new BatchMockAgent([[runStarted(), runFinished()]]);
    await collectEvents(middleware.run(createRunAgentInput(), first));

    const second = new BatchMockAgent([[runStarted("r2"), runFinished("r2")]]);
    await collectEvents(middleware.run(createRunAgentInput({ runId: "r2" }), second));

    // The failed listing is cached too — we don't keep hammering broken servers.
    expect(mockListTools).toHaveBeenCalledTimes(1);
    // No tools were injected on either run.
    expect(first.runCalls[0].tools).toHaveLength(0);
    expect(second.runCalls[0].tools).toHaveLength(0);
  });
});

// --- Run-lifecycle ordering ---------------------------------------------------
// AG-UI verify rejects events sent after RUN_FINISHED until a new RUN_STARTED.
// The middleware presents the whole tool loop as ONE run: a single
// RUN_STARTED first, a single RUN_FINISHED last, and every TOOL_CALL_RESULT
// in between — continuation runs' RUN_STARTED/RUN_FINISHED are hidden.
describe("MCPMiddleware — RUN_FINISHED ordering", () => {
  it("presents a loop as one run: single STARTED/FINISHED, results inside", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "sunny" }] });
    const next = new BatchMockAgent([
      [runStarted(), ...toolCall("c1", "mcp__s__weather"), runFinished()],
      [runStarted("r2"), ...textMessage("m2", "done"), runFinished("r2")],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );

    const types = received.map((e) => e.type);
    const idxResult = types.indexOf(EventType.TOOL_CALL_RESULT);
    const idxFinish = types.indexOf(EventType.RUN_FINISHED);

    // Exactly one RUN_STARTED and one RUN_FINISHED — the continuation's are hidden.
    expect(types.filter((t) => t === EventType.RUN_STARTED)).toHaveLength(1);
    expect(types.filter((t) => t === EventType.RUN_FINISHED)).toHaveLength(1);
    // RUN_STARTED first, RUN_FINISHED last.
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    // The tool result lands inside the run, before the single RUN_FINISHED.
    expect(idxResult).toBeGreaterThan(-1);
    expect(idxFinish).toBeGreaterThan(idxResult);
  });

  it("emits TOOL_CALL_RESULTs before RUN_FINISHED in scenario 2 (stop)", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [
        runStarted(),
        ...toolCall("c1", "mcp__s__weather"),
        ...toolCall("c2", "frontendTool"),
        runFinished(),
      ],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );

    const types = received.map((e) => e.type);
    const idxResult = types.indexOf(EventType.TOOL_CALL_RESULT);
    const idxFinish = types.indexOf(EventType.RUN_FINISHED);
    expect(idxResult).toBeGreaterThan(-1);
    expect(idxFinish).toBeGreaterThan(idxResult);
    // Exactly one RUN_FINISHED — the held one, emitted after results.
    expect(types.filter((t) => t === EventType.RUN_FINISHED)).toHaveLength(1);
  });

  it("non-interference: a single RUN_FINISHED still arrives last", async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: "weather", inputSchema: {} }] });
    const next = new BatchMockAgent([
      [runStarted(), ...textMessage("m1", "hi"), runFinished()],
    ]);
    const received = await collectEvents(
      new MCPMiddleware([weatherServer()]).run(createRunAgentInput(), next),
    );
    expect(received[received.length - 1].type).toBe(EventType.RUN_FINISHED);
  });
});
