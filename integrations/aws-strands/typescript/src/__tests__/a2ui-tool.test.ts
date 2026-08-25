/**
 * Unit tests for the AWS Strands A2UI subagent tool, covering both wiring
 * modes (explicit + auto-injected) and message-shape helpers:
 *
 *   Explicit wiring: `getA2UITools(params)` returns a Strands tool named
 *   `generate_a2ui` that runs the toolkit recovery loop.
 *
 *   Auto-injection: `planA2UIInjection(...)` is the pure decision the
 *   adapter makes per run — read the runtime `injectA2UITool` flag off
 *   `forwardedProps`, infer the model from the wrapped agent, resolve the
 *   catalog from `input.context`, and decide whether to inject `generate_a2ui`
 *   (and which injected render tool to drop). Returns `null` when it must NOT
 *   inject.
 *
 * String literals below mirror the shared constants (`GENERATE_A2UI_TOOL_NAME`
 * from @ag-ui/a2ui-toolkit, `RENDER_A2UI_TOOL_NAME` +
 * `A2UI_SCHEMA_CONTEXT_DESCRIPTION` from @ag-ui/a2ui-middleware), hardcoded to
 * avoid a cross-package dep just for test constants.
 */
import { describe, it, expect, vi } from "vitest";

import { EventType } from "@ag-ui/core";
import {
  getA2UITools,
  planA2UIInjection,
  isAutoInjectedA2UITool,
  stripInFlightToolCall,
  strandsToolResultsToAgui,
  classifyA2UISubagentError,
} from "../a2ui-tool";
import { collect, minimalRunInput, scriptedStrandsAgent } from "./helpers";

/** Minimal registry that records adds, supporting the methods the adapter uses. */
function fakeRegistry(opts: { withList?: boolean; throwOnAdd?: string } = {}) {
  const tools = new Map<string, { name: string }>();
  const reg: Record<string, unknown> = {
    add: (t: { name: string }) => {
      if (opts.throwOnAdd && t?.name === opts.throwOnAdd) {
        throw new Error(`add boom: ${t.name}`);
      }
      tools.set(t.name, t);
    },
    get: (n: string) => tools.get(n),
    getByName: (n: string) => tools.get(n),
    remove: (t: unknown) =>
      tools.delete(typeof t === "string" ? t : (t as { name?: string })?.name ?? ""),
    removeByName: (n: string) => tools.delete(n),
    values: () => Array.from(tools.values()),
  };
  if (opts.withList !== false) reg.list = () => Array.from(tools.values());
  return { reg, tools };
}

const RENDER_TOOL_INPUT = {
  name: "render_a2ui",
  description: "render",
  parameters: { type: "object", properties: {} },
};

const GENERATE_A2UI_TOOL_NAME = "generate_a2ui";
const RENDER_A2UI_TOOL_NAME = "render_a2ui";
const A2UI_SCHEMA_CONTEXT_DESCRIPTION =
  "A2UI Component Schema — available components for generating UI surfaces. Use these component names and properties when creating A2UI operations.";

const stubModel = { modelId: "stub-model" };
const CATALOG = {
  components: {
    Row: { required: ["children"] },
    HotelCard: { required: ["name", "rating"] },
  },
};

describe("getA2UITools — explicit factory", () => {
  it("requires a model (silent default-Bedrock fallback is a footgun)", () => {
    expect(() => getA2UITools({} as never)).toThrow(/model/);
  });

  it("returns a Strands tool named 'generate_a2ui' by default", () => {
    const tool = getA2UITools({ model: stubModel });
    expect(tool.name).toBe(GENERATE_A2UI_TOOL_NAME);
    // Strands tool contract: has a toolSpec + an async stream().
    expect(tool.toolSpec?.name).toBe(GENERATE_A2UI_TOOL_NAME);
    expect(typeof tool.stream).toBe("function");
  });

  it("honors a custom tool name", () => {
    const tool = getA2UITools({ model: stubModel, toolName: "make_ui" });
    expect(tool.name).toBe("make_ui");
  });
});

describe("planA2UIInjection — auto-inject decision", () => {
  it("injects generate_a2ui when the runtime flag is true and a model is inferable", () => {
    const input = minimalRunInput({ forwardedProps: { injectA2UITool: true } });
    const plan = planA2UIInjection({
      model: stubModel,
      input,
      existingToolNames: [],
    });
    expect(plan).not.toBeNull();
    expect(plan!.tool.name).toBe(GENERATE_A2UI_TOOL_NAME);
    expect(plan!.toolName).toBe(GENERATE_A2UI_TOOL_NAME);
    // The injected render tool (default name) is dropped from advertised tools
    // so the model calls generate_a2ui, not render_a2ui directly.
    expect(plan!.dropToolNames).toContain(RENDER_A2UI_TOOL_NAME);
  });

  it("drops the injected render tool under its CUSTOM name when the flag is a string", () => {
    const input = minimalRunInput({
      forwardedProps: { injectA2UITool: "render_ui_custom" },
    });
    const plan = planA2UIInjection({
      model: stubModel,
      input,
      existingToolNames: [],
    });
    expect(plan).not.toBeNull();
    // The string names the INJECTED render tool to drop — the server-side
    // sub-agent tool we register stays `generate_a2ui`.
    expect(plan!.toolName).toBe(GENERATE_A2UI_TOOL_NAME);
    expect(plan!.dropToolNames).toContain("render_ui_custom");
  });

  it("does NOT inject and warns when no model is inferable (orchestrator: Graph/Swarm)", () => {
    const warn = vi.fn();
    const input = minimalRunInput({ forwardedProps: { injectA2UITool: true } });
    const plan = planA2UIInjection({
      model: null,
      input,
      existingToolNames: [],
      log: { warn },
    });
    expect(plan).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/orchestrator|model/i);
  });

  it("does NOT inject when neither the runtime flag nor a backend override is set", () => {
    const plan = planA2UIInjection({
      model: stubModel,
      input: minimalRunInput(),
      existingToolNames: [],
    });
    expect(plan).toBeNull();
  });

  it("injects on a backend override even without the runtime flag (non-CopilotKit hosts)", () => {
    const plan = planA2UIInjection({
      model: stubModel,
      input: minimalRunInput(),
      existingToolNames: [],
      config: { injectA2UITool: true },
    });
    expect(plan).not.toBeNull();
    expect(plan!.tool.name).toBe(GENERATE_A2UI_TOOL_NAME);
  });

  // THE "USER PREVAILS" REQUIREMENT.
  it("USER PREVAILS: does NOT double-inject when the dev already wired generate_a2ui and the runtime flag is on", () => {
    const input = minimalRunInput({ forwardedProps: { injectA2UITool: true } });
    const plan = planA2UIInjection({
      model: stubModel,
      input,
      existingToolNames: [GENERATE_A2UI_TOOL_NAME], // dev's explicit getA2UITools()
    });
    // Explicit dev wiring wins: no second generate_a2ui is registered.
    expect(plan).toBeNull();
  });

  it("ignores the catalog in the schema context entry (no validation auto-resolve)", () => {
    // Mirrors the LangGraph adapter: a catalog carried in RunAgentInput.context
    // is NOT auto-resolved into the validation catalog. Only an explicit
    // config.catalog enables catalog-aware recovery.
    const input = minimalRunInput({
      forwardedProps: { injectA2UITool: true },
      context: [
        {
          description: A2UI_SCHEMA_CONTEXT_DESCRIPTION,
          value: JSON.stringify(CATALOG),
        },
      ],
    });
    const plan = planA2UIInjection({
      model: stubModel,
      input,
      existingToolNames: [],
    });
    expect(plan).not.toBeNull();
    expect(plan!.catalog).toBeUndefined();
  });

  it("uses an explicit config.catalog unchanged", () => {
    const plan = planA2UIInjection({
      model: stubModel,
      input: minimalRunInput({ forwardedProps: { injectA2UITool: true } }),
      existingToolNames: [],
      config: { catalog: CATALOG },
    });
    expect(plan).not.toBeNull();
    expect(plan!.catalog).toEqual(CATALOG);
  });

  it("tags the injected tool so the adapter can distinguish it from a dev-wired one", () => {
    const plan = planA2UIInjection({
      model: stubModel,
      input: minimalRunInput({ forwardedProps: { injectA2UITool: true } }),
      existingToolNames: [],
    });
    expect(plan).not.toBeNull();
    expect(isAutoInjectedA2UITool(plan!.tool)).toBe(true);
    // A dev-wired tool carries no marker.
    expect(isAutoInjectedA2UITool(getA2UITools({ model: stubModel }))).toBe(
      false,
    );
  });
});

describe("Strands message-shape helpers (real SDK block types)", () => {
  // Real @strands-agents/sdk blocks use `type: "toolUseBlock" | "toolResultBlock"
  // | "textBlock"` — NOT "toolUse"/"ToolResultBlock". These tests pin the
  // discriminants so a regression doesn't silently no-op the strip / conversion.
  const A2UI_OPS_KEY = "a2ui_operations";

  it("stripInFlightToolCall drops a trailing toolUseBlock for the tool", () => {
    const messages = [
      { role: "user", content: [{ type: "textBlock", text: "compare hotels" }] },
      {
        role: "assistant",
        content: [
          { type: "toolUseBlock", name: "generate_a2ui", toolUseId: "t1", input: {} },
        ],
      },
    ];
    const stripped = stripInFlightToolCall(messages, "generate_a2ui");
    expect(stripped).toHaveLength(1);
    expect(stripped[0].role).toBe("user");
  });

  it("stripInFlightToolCall keeps a trailing user turn", () => {
    const messages = [
      { role: "user", content: [{ type: "textBlock", text: "compare hotels" }] },
    ];
    expect(stripInFlightToolCall(messages, "generate_a2ui")).toHaveLength(1);
  });

  it("strandsToolResultsToAgui reconstructs tool messages from real toolResultBlock content", () => {
    const envelope = JSON.stringify({ [A2UI_OPS_KEY]: [{ version: "v0.9" }] });
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "toolResultBlock",
            toolUseId: "tc1",
            content: [{ type: "textBlock", text: envelope }],
          },
        ],
      },
    ];
    const agui = strandsToolResultsToAgui(messages);
    expect(agui).toHaveLength(1);
    expect(agui[0].role).toBe("tool");
    expect((agui[0] as { toolCallId?: string }).toolCallId).toBe("tc1");
    expect(agui[0].content).toContain(A2UI_OPS_KEY);
  });

  it("strandsToolResultsToAgui reconstructs from SERIALIZED bare {text}/{json} blocks (no type discriminant)", () => {
    const envelope = JSON.stringify({ [A2UI_OPS_KEY]: [{ version: "v0.9" }] });
    // Bare {text} — what _buildStrandsHistory emits / fromMessageData carries.
    const fromText = strandsToolResultsToAgui([
      {
        role: "user",
        content: [{ toolResult: { toolUseId: "tc1", content: [{ text: envelope }] } }],
      },
    ]);
    expect(fromText).toHaveLength(1);
    expect(fromText[0].content).toContain(A2UI_OPS_KEY);
    // Bare {json}.
    const fromJson = strandsToolResultsToAgui([
      {
        role: "user",
        content: [
          {
            type: "toolResultBlock",
            toolUseId: "tc2",
            content: [{ json: { [A2UI_OPS_KEY]: [{ version: "v0.9" }] } }],
          },
        ],
      },
    ]);
    expect(fromJson).toHaveLength(1);
    expect(fromJson[0].content).toContain(A2UI_OPS_KEY);
  });

  it("strandsToolResultsToAgui ignores non-A2UI tool results", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "toolResultBlock",
            toolUseId: "tc1",
            content: [{ type: "textBlock", text: "just a weather result" }],
          },
        ],
      },
    ];
    expect(strandsToolResultsToAgui(messages)).toHaveLength(0);
  });
});

describe("auto-inject across turns (F1 regression)", () => {
  // The middleware injects render_a2ui into RunAgentInput.tools on EVERY turn.
  const renderProxyTool = {
    name: RENDER_A2UI_TOOL_NAME,
    description: "render a2ui",
    parameters: { type: "object", properties: {} },
  };
  const turnInput = () =>
    minimalRunInput({
      forwardedProps: { injectA2UITool: true },
      tools: [renderProxyTool],
    });

  it("re-injects generate_a2ui and keeps render_a2ui dropped on the 2nd turn of a cached thread", async () => {
    const agent = scriptedStrandsAgent([]);
    const registry = (
      agent as unknown as {
        _agentsByThread: Map<string, { toolRegistry: { list(): { name: string }[] } }>;
      }
    )._agentsByThread.get("thread-1")!.toolRegistry;

    // Turn 1
    await collect(agent, turnInput());
    let names = registry.list().map((t) => t.name);
    expect(names).toContain("generate_a2ui");
    expect(names).not.toContain("render_a2ui");

    // Turn 2 on the SAME cached agent: render_a2ui is re-synced by
    // syncProxyTools, and must be dropped again (the bug left it registered
    // alongside generate_a2ui, letting the model bypass the recovery loop).
    await collect(agent, turnInput());
    names = registry.list().map((t) => t.name);
    expect(names).toContain("generate_a2ui");
    expect(names).not.toContain("render_a2ui");
    expect(names.filter((n) => n === "generate_a2ui")).toHaveLength(1);
  });
});

describe("A2UI sub-agent streaming → synthetic inner TOOL_CALL events", () => {
  // The generate_a2ui tool yields ToolStreamEvents carrying the sub-agent's
  // render_a2ui progress; the adapter must re-emit them as TOOL_CALL_START/
  // ARGS/END so the a2ui middleware can drive the "building" skeleton and
  // progressive paint (without them the surface only bulk-paints from the
  // final result).
  const A2UI_STREAM_KEY = "__a2uiRenderStream";
  const streamEvt = (payload: Record<string, unknown>) => ({
    type: "toolStreamEvent",
    data: { [A2UI_STREAM_KEY]: payload },
  });

  it("re-emits start/args/end payloads as inner TOOL_CALL events on the wire", async () => {
    const agent = scriptedStrandsAgent([
      streamEvt({ kind: "start", toolCallId: "r1", toolCallName: "render_a2ui" }),
      streamEvt({ kind: "args", toolCallId: "r1", delta: '{"surfaceId":' }),
      streamEvt({ kind: "args", toolCallId: "r1", delta: '"s1"}' }),
      streamEvt({ kind: "end", toolCallId: "r1" }),
    ]);
    const events = await collect(agent);

    const start = events.find(
      (e) =>
        e.type === EventType.TOOL_CALL_START &&
        (e as { toolCallName?: string }).toolCallName === "render_a2ui",
    ) as { toolCallId?: string } | undefined;
    expect(start).toBeDefined();
    expect(start!.toolCallId).toBe("r1");

    const argDeltas = events
      .filter(
        (e) =>
          e.type === EventType.TOOL_CALL_ARGS &&
          (e as { toolCallId?: string }).toolCallId === "r1",
      )
      .map((e) => (e as { delta?: string }).delta);
    expect(argDeltas.join("")).toBe('{"surfaceId":"s1"}');

    expect(
      events.some(
        (e) =>
          e.type === EventType.TOOL_CALL_END &&
          (e as { toolCallId?: string }).toolCallId === "r1",
      ),
    ).toBe(true);
  });

  it("ignores non-a2ui toolStreamEvent payloads (state path unaffected)", async () => {
    const agent = scriptedStrandsAgent([
      { type: "toolStreamEvent", data: { state: { steps: [1] } } },
    ]);
    const events = await collect(agent);
    expect(
      events.some(
        (e) =>
          e.type === EventType.STATE_SNAPSHOT &&
          JSON.stringify((e as { snapshot?: unknown }).snapshot).includes("steps"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(false);
  });
});

describe("generate_a2ui sub-agent — single forced render turn (hang regression)", () => {
  const A2UI_STREAM_KEY = "__a2uiRenderStream";

  it("drives ONE forced render_a2ui model call (no agentic continuation) and returns the envelope", async () => {
    // A full Agent loop would execute the render tool and then fire a SECOND
    // model call that never settles — the outer generate_a2ui would hang and
    // the run would never emit RUN_FINISHED. The fix streams the MODEL directly
    // for a single forced turn; this locks that contract in.
    const toolChoices: unknown[] = [];
    const fakeModel = {
      modelId: "fake",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *stream(_messages: unknown, opts?: any) {
        toolChoices.push(opts?.toolChoice);
        yield {
          type: "modelContentBlockStartEvent",
          start: { type: "toolUseStart", toolUseId: "r1", name: "render_a2ui" },
        };
        yield {
          type: "modelContentBlockDeltaEvent",
          delta: {
            type: "toolUseInputDelta",
            input:
              '{"surfaceId":"s1","components":[{"id":"root","component":"Row"}]}',
          },
        };
        yield { type: "modelContentBlockStopEvent" };
      },
    };

    const tool = getA2UITools({ model: fakeModel as never });
    const ctx = {
      toolUse: { toolUseId: "tu-1", input: {} },
      agent: { messages: [] },
    };
    const events: unknown[] = [];
    // The tool RETURNS the ToolResultBlock (not yielded), so iterate manually
    // to capture the generator return value.
    const gen = (
      tool as { stream: (c: unknown) => AsyncGenerator<unknown, unknown> }
    ).stream(ctx);
    let result: unknown;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        result = step.value;
        break;
      }
      events.push(step.value);
    }

    // Single forced turn — the model is called exactly once, forced to render.
    expect(toolChoices).toEqual([{ tool: { name: "render_a2ui" } }]);

    // Synthetic inner render events were streamed (progressive paint).
    const payloads = events
      .map(
        (e) =>
          (e as { data?: Record<string, { kind?: string }> }).data?.[
            A2UI_STREAM_KEY
          ],
      )
      .filter(Boolean) as Array<{ kind?: string }>;
    expect(payloads.some((p) => p.kind === "start")).toBe(true);
    expect(payloads.some((p) => p.kind === "end")).toBe(true);

    // The committed envelope reaches the outer loop (so the run can finish).
    const ret = result as { content?: Array<{ text?: string }> };
    const text = ret?.content?.[0]?.text ?? JSON.stringify(ret);
    expect(text).toContain("a2ui_operations");
  });
});

describe("classifyA2UISubagentError (cancel / adapter-bug vs recoverable)", () => {
  it("rethrows on an aborted signal regardless of error", () => {
    expect(classifyA2UISubagentError(new Error("any"), true)).toBe("rethrow");
  });
  it("rethrows AbortError / CancelledError", () => {
    const abort = Object.assign(new Error("x"), { name: "AbortError" });
    const cancelled = Object.assign(new Error("x"), { name: "CancelledError" });
    expect(classifyA2UISubagentError(abort, false)).toBe("rethrow");
    expect(classifyA2UISubagentError(cancelled, false)).toBe("rethrow");
  });
  it("rethrows programmer errors (TypeError / ReferenceError = adapter bug)", () => {
    expect(classifyA2UISubagentError(new TypeError("x"), false)).toBe("rethrow");
    expect(classifyA2UISubagentError(new ReferenceError("x"), false)).toBe("rethrow");
  });
  it("treats undici network TypeErrors as recoverable, not adapter bugs", () => {
    // Node 18+ fetch rejects with `TypeError: fetch failed` (+ errno cause) —
    // the canonical TRANSIENT network error the recovery loop must absorb.
    const fetchFailed = new TypeError("fetch failed");
    (fetchFailed as { cause?: unknown }).cause = new Error("ECONNREFUSED");
    expect(classifyA2UISubagentError(fetchFailed, false)).toBe("recoverable");
    expect(classifyA2UISubagentError(new TypeError("fetch failed"), false)).toBe(
      "recoverable",
    );
    // A bare TypeError with no network shape stays an adapter bug — and so
    // does a CAUSED non-network TypeError or one merely mentioning "fetch"
    // (exact-message match only).
    expect(
      classifyA2UISubagentError(new TypeError("x is not a function"), false),
    ).toBe("rethrow");
    const causedBug = new TypeError("oops");
    (causedBug as { cause?: unknown }).cause = new Error("inner");
    expect(classifyA2UISubagentError(causedBug, false)).toBe("rethrow");
    expect(
      classifyA2UISubagentError(
        new TypeError("this.fetchCatalog is not a function"),
        false,
      ),
    ).toBe("rethrow");
  });
  it("treats a genuine model/network error as a recoverable failed attempt", () => {
    expect(classifyA2UISubagentError(new Error("Bedrock 429"), false)).toBe(
      "recoverable",
    );
  });
});

describe("auto-inject error handling in the adapter run (R4/R5 behaviors)", () => {
  it("degrades gracefully when injecting the tool throws — run still finishes, no RUN_ERROR", async () => {
    // Registry that lets proxy-sync succeed but throws when adding generate_a2ui.
    const { reg } = fakeRegistry({ throwOnAdd: "generate_a2ui" });
    const agent = scriptedStrandsAgent([], {
      stubOverrides: { toolRegistry: reg as never },
      config: { a2ui: { injectA2UITool: true } },
    });
    const events = await collect(
      agent,
      minimalRunInput({ tools: [RENDER_TOOL_INPUT] }),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(types).not.toContain(EventType.RUN_ERROR);
  });

  it("skips injection (no crash) when the registry exposes no list()", async () => {
    const { reg, tools } = fakeRegistry({ withList: false });
    const agent = scriptedStrandsAgent([], {
      stubOverrides: { toolRegistry: reg as never },
      config: { a2ui: { injectA2UITool: true } },
    });
    const events = await collect(
      agent,
      minimalRunInput({ tools: [RENDER_TOOL_INPUT] }),
    );
    expect(events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
    // Could not enumerate to dedup/refresh → must NOT inject (never clobber).
    expect(tools.has("generate_a2ui")).toBe(false);
  });
});

describe("planA2UIInjection — nullish flag + catalog degradation", () => {
  it("explicit runtime injectA2UITool=false beats a backend opt-in (?? not ||)", () => {
    const plan = planA2UIInjection({
      model: {},
      input: minimalRunInput({ forwardedProps: { injectA2UITool: false } }),
      existingToolNames: [],
      config: { injectA2UITool: true },
    });
    expect(plan).toBeNull();
  });

  // Catalog-id resolution + config-overrides-runtime precedence is unit-tested
  // at the toolkit level (resolveA2UICatalog). The streamed-args catalogId stamp
  // is covered by the aws-strands-typescript A2UI e2e specs.
});
