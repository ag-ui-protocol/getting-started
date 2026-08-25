/**
 * End-to-end regression for the dynamic-A2UI hang: drive a REAL Strands `Agent`
 * loop (not a scripted stub) with a fake `Model` that scripts the full
 * conversation — outer turn calls the auto-injected `generate_a2ui`, the
 * sub-agent's single forced `render_a2ui` turn paints the surface, the envelope
 * returns to the outer loop, and the agent narrates. The run MUST emit
 * RUN_FINISHED instead of hanging on a still-Running generate_a2ui.
 */
import { describe, it, expect } from "vitest";

import { Agent, Model } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";

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

  getConfig() {
    return { modelId: "fake" };
  }

  updateConfig() {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *stream(messages: any, options?: any) {
    const tc = options?.toolChoice;
    if (tc?.tool?.name === RENDER_A2UI_TOOL_NAME) {
      this.renderCalls++;
      for (const ev of toolUseEvents(
        RENDER_A2UI_TOOL_NAME,
        "render-1",
        '{"surfaceId":"s1","components":[{"id":"root","component":"Row"}],"data":{}}',
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
