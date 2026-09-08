/**
 * End-to-end regression for the dynamic-A2UI hang: drive a REAL Strands `Agent`
 * loop (not a scripted stub) with a fake `Model` that scripts the full
 * conversation — outer turn calls the auto-injected `generate_a2ui`, the
 * sub-agent's single forced `render_a2ui` turn paints the surface, the envelope
 * returns to the outer loop, and the agent narrates. The run MUST emit
 * RUN_FINISHED instead of hanging on a still-Running generate_a2ui.
 */
import { describe, it, expect, vi } from "vitest";

import { Agent, Model } from "@strands-agents/sdk";
import { EventType, type BaseEvent } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";
import { collect, expectCompletedRun, minimalRunInput } from "./helpers";

const GENERATE_A2UI_TOOL_NAME = "generate_a2ui";
const RENDER_A2UI_TOOL_NAME = "render_a2ui";

const RENDER_TOOL_INPUT = {
  name: RENDER_A2UI_TOOL_NAME,
  description: "render",
  parameters: { type: "object", properties: {} },
};

function toolUseEvents(name: string, toolUseId: string, input: string) {
  return [
    { type: "modelMessageStartEvent", role: "assistant" },
    {
      type: "modelContentBlockStartEvent",
      start: { type: "toolUseStart", name, toolUseId },
    },
    {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "toolUseInputDelta", input },
    },
    { type: "modelContentBlockStopEvent" },
    { type: "modelMessageStopEvent", stopReason: "toolUse" },
  ];
}

function textEvents(text: string) {
  return [
    { type: "modelMessageStartEvent", role: "assistant" },
    {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text },
    },
    { type: "modelContentBlockStopEvent" },
    { type: "modelMessageStopEvent", stopReason: "endTurn" },
  ];
}

/**
 * Scripts the full dynamic-A2UI conversation across the OUTER Strands agent loop
 * AND the inner forced render turn. The forced render turn (sub-agent) is
 * identified by its toolChoice; the outer turn calls generate_a2ui first, then
 * narrates once its result is in history.
 */
class DynamicA2UIFakeModel extends Model {
  renderCalls = 0;
  outerCalls = 0;

  /**
   * `renderArgs[n]` is the args JSON the nth forced render turn emits, so a
   * test can drive an omitted `surfaceId` or a first attempt that fails
   * validation. Past the end, the last entry repeats.
   */
  constructor(
    private readonly renderArgs: string[] = [
      '{"surfaceId":"s1","components":[{"id":"root","component":"Row"}],"data":{}}',
    ],
  ) {
    super();
  }

  getConfig() {
    return { modelId: "fake" };
  }

  updateConfig() {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *stream(messages: any, options?: any) {
    const tc = options?.toolChoice;
    if (tc?.tool?.name === RENDER_A2UI_TOOL_NAME) {
      const args =
        this.renderArgs[this.renderCalls] ??
        this.renderArgs[this.renderArgs.length - 1];
      this.renderCalls++;
      for (const ev of toolUseEvents(
        RENDER_A2UI_TOOL_NAME,
        `render-${this.renderCalls}`,
        args,
      )) {
        yield ev as never;
      }
      return;
    }

    this.outerCalls++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alreadyGenerated = (messages as any[]).some(
      (m) =>
        m?.role === "assistant" &&
        Array.isArray(m.content) &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        m.content.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (b: any) =>
            (b?.name ?? b?.toolUse?.name) === GENERATE_A2UI_TOOL_NAME,
        ),
    );
    // outerCalls guard guarantees termination even if detection drifts.
    if (alreadyGenerated || this.outerCalls >= 2) {
      for (const ev of textEvents("Here is your sales dashboard.")) {
        yield ev as never;
      }
    } else {
      for (const ev of toolUseEvents(
        GENERATE_A2UI_TOOL_NAME,
        "gen-1",
        '{"intent":"create"}',
      )) {
        yield ev as never;
      }
    }
  }
}

describe("end-to-end dynamic A2UI run (real Strands loop, hang regression)", () => {
  it("auto-injects generate_a2ui, paints the surface, returns the result, and emits RUN_FINISHED", async () => {
    const model = new DynamicA2UIFakeModel();
    const core = new Agent({
      model: model as never,
      systemPrompt: "You render UIs.",
      tools: [],
    });
    const agent = new StrandsAgent({ agent: core, name: "strands-e2e" });

    const events = await collect(
      agent,
      minimalRunInput({
        forwardedProps: { injectA2UITool: true },
        tools: [RENDER_TOOL_INPUT] as never,
        messages: [
          { id: "u1", role: "user", content: "Show my sales dashboard" },
        ] as never,
      }),
    );
    const types = events.map((e) => e.type);

    // generate_a2ui was auto-injected, called, and its result returned to the loop.
    expect(
      events.some(
        (e) =>
          e.type === EventType.TOOL_CALL_START &&
          (e as { toolCallName?: string }).toolCallName ===
            GENERATE_A2UI_TOOL_NAME,
      ),
    ).toBe(true);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);

    // The A2UI surface painted (inner render_a2ui streamed as synthetic events).
    expect(
      events.some(
        (e) =>
          e.type === EventType.TOOL_CALL_START &&
          (e as { toolCallName?: string }).toolCallName ===
            RENDER_A2UI_TOOL_NAME,
      ),
    ).toBe(true);

    // The agent narrated and the run COMPLETED (no hang, no error).
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(types).not.toContain(EventType.RUN_ERROR);

    // Exactly one forced render turn — no agentic continuation in the sub-agent.
    expect(model.renderCalls).toBe(1);
    // Outer loop: one generate call + one narration.
    expect(model.outerCalls).toBe(2);
  });
});

/**
 * The A2UI operations `generate_a2ui` returned to the outer loop, read off the
 * TOOL_CALL_RESULT paired with its call. Fails loudly when the run produced no
 * such call or result, so an assertion about the ops can't hold vacuously.
 */
function a2uiOperationsOf(
  events: BaseEvent[],
): Array<Record<string, Record<string, unknown>>> {
  const start = events.find(
    (e) =>
      e.type === EventType.TOOL_CALL_START &&
      (e as { toolCallName?: string }).toolCallName === GENERATE_A2UI_TOOL_NAME,
  ) as { toolCallId?: string } | undefined;
  expect(start, "run produced no generate_a2ui call").toBeDefined();
  const result = events.find(
    (e) =>
      e.type === EventType.TOOL_CALL_RESULT &&
      (e as { toolCallId?: string }).toolCallId === start!.toolCallId,
  ) as { content?: string } | undefined;
  expect(result, "generate_a2ui produced no result").toBeDefined();
  const envelope = JSON.parse(result!.content ?? "") as {
    a2ui_operations?: Array<Record<string, Record<string, unknown>>>;
  };
  expect(
    envelope.a2ui_operations,
    `generate_a2ui returned no operations: ${result!.content}`,
  ).toBeDefined();
  return envelope.a2ui_operations!;
}

/** Drive one auto-injected A2UI run over `model` with the given adapter config. */
function runDynamicA2UI(
  model: DynamicA2UIFakeModel,
  config: StrandsAgentConfig = {},
): Promise<BaseEvent[]> {
  const core = new Agent({
    model: model as never,
    systemPrompt: "You render UIs.",
    tools: [],
  });
  const agent = new StrandsAgent({ agent: core, name: "strands-e2e", config });
  return collect(
    agent,
    minimalRunInput({
      forwardedProps: { injectA2UITool: true },
      tools: [RENDER_TOOL_INPUT] as never,
      messages: [
        { id: "u1", role: "user", content: "Show my sales dashboard" },
      ] as never,
    }),
  );
}

describe("auto-injected A2UI generation options (config.a2ui)", () => {
  it("stamps config.a2ui.defaultSurfaceId when the sub-agent omits surfaceId", async () => {
    // No `surfaceId` in the render args: the id on the resulting ops can only
    // come from the configured default.
    const model = new DynamicA2UIFakeModel([
      '{"components":[{"id":"root","component":"Row"}],"data":{}}',
    ]);
    const events = await runDynamicA2UI(model, {
      a2ui: { defaultSurfaceId: "sales-panel" },
    });

    expectCompletedRun(events, "defaultSurfaceId run");
    const ops = a2uiOperationsOf(events);
    const created = ops.find((op) => op.createSurface);
    expect(
      created,
      `no createSurface op: ${JSON.stringify(ops)}`,
    ).toBeDefined();
    expect(created!.createSurface.surfaceId).toBe("sales-panel");
    // Every op addresses the same surface, or the renderer paints into nothing.
    const targets = ops.map(
      (op) =>
        (op.createSurface ?? op.updateComponents ?? op.updateDataModel)
          ?.surfaceId,
    );
    expect(targets).toEqual(["sales-panel", "sales-panel"]);
  });

  it("reports each recovery attempt to config.a2ui.onA2UIAttempt", async () => {
    // Attempt 1 has no component with id "root" (structural failure, no catalog
    // needed); attempt 2 does, so the loop recovers and commits.
    const seen: Array<{ attempt: number; ok: boolean; codes: string[] }> = [];
    const model = new DynamicA2UIFakeModel([
      '{"surfaceId":"s1","components":[{"id":"header","component":"Row"}],"data":{}}',
      '{"surfaceId":"s1","components":[{"id":"root","component":"Row"}],"data":{}}',
    ]);
    const events = await runDynamicA2UI(model, {
      a2ui: {
        onA2UIAttempt: (record) =>
          seen.push({
            attempt: record.attempt,
            ok: record.ok,
            codes: record.errors.map((e) => e.code),
          }),
      },
    });

    expectCompletedRun(events, "onA2UIAttempt run");
    expect(seen).toEqual([
      { attempt: 1, ok: false, codes: ["no_root"] },
      { attempt: 2, ok: true, codes: [] },
    ]);
    expect(model.renderCalls).toBe(2);
    // The recovered surface still reached the outer loop.
    const ops = a2uiOperationsOf(events);
    expect(ops.find((op) => op.createSurface)?.createSurface.surfaceId).toBe(
      "s1",
    );
  });

  it("contains a throwing onA2UIAttempt hook rather than discarding the valid surface", async () => {
    // The toolkit fires the hook before it builds the envelope, so an
    // unguarded throw would lose a surface that already validated.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const model = new DynamicA2UIFakeModel();
      const events = await runDynamicA2UI(model, {
        a2ui: {
          onA2UIAttempt: () => {
            throw new Error("host hook boom");
          },
        },
      });

      expectCompletedRun(events, "throwing-hook run");
      const ops = a2uiOperationsOf(events);
      expect(ops.find((op) => op.createSurface)?.createSurface.surfaceId).toBe(
        "s1",
      );
      // Swallowed, but not silently: the failure is on the record.
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /onA2UIAttempt hook threw on attempt 1.*host hook boom/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("contains an async onA2UIAttempt hook that rejects", async () => {
    // The callback type is `=> void`, which an async function also satisfies,
    // so a rejected hook promise would escape the synchronous try/catch and
    // surface as an unhandled rejection instead of being contained.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const model = new DynamicA2UIFakeModel();
      const events = await runDynamicA2UI(model, {
        a2ui: {
          onA2UIAttempt: async () => {
            throw new Error("async hook boom");
          },
        },
      });

      expectCompletedRun(events, "async-throwing-hook run");
      const ops = a2uiOperationsOf(events);
      expect(ops.find((op) => op.createSurface)?.createSurface.surfaceId).toBe(
        "s1",
      );
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /onA2UIAttempt hook threw on attempt 1.*async hook boom/,
      );
      // Give any escaped rejection a turn of the loop to be reported.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });
});
