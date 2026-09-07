import { describe, expect, it, vi } from "vitest";
import { EventType, type Tool as AguiTool } from "@ag-ui/core";
import {
  Agent,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  tool,
  type ModelStreamEvent,
} from "@strands-agents/sdk";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";

const THREAD_ID = "interrupt-client-tool-thread";
const TOOL_NAME = "confirm_action";
const CLIENT_TOOL: AguiTool = {
  name: TOOL_NAME,
  description: "Confirm an action in the client",
  parameters: { type: "object", properties: {} },
};
const NATIVE_TOOL = tool({
  name: TOOL_NAME,
  description: "Confirm an action on the server",
  inputSchema: { type: "object", properties: {} },
  callback: () => ({ confirmed: true }),
});

class ToolCallModel extends Model {
  private issuedToolCall = false;
  private toolUseSequence = 0;

  getConfig() {
    return { modelId: "interrupt-client-tool-test" };
  }

  updateConfig() {}

  beginRun() {
    this.issuedToolCall = false;
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield new ModelMessageStartEvent({
      type: "modelMessageStartEvent",
      role: "assistant",
    });
    if (!this.issuedToolCall) {
      this.issuedToolCall = true;
      this.toolUseSequence += 1;
      yield new ModelContentBlockStartEvent({
        type: "modelContentBlockStartEvent",
        start: {
          type: "toolUseStart",
          name: TOOL_NAME,
          toolUseId: `tool-${this.toolUseSequence}`,
        },
      });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: "{}" },
      });
      yield new ModelContentBlockStopEvent({
        type: "modelContentBlockStopEvent",
      });
      yield new ModelMessageStopEvent({
        type: "modelMessageStopEvent",
        stopReason: "toolUse",
      });
      return;
    }

    yield new ModelContentBlockDeltaEvent({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "done" },
    });
    yield new ModelContentBlockStopEvent({
      type: "modelContentBlockStopEvent",
    });
    yield new ModelMessageStopEvent({
      type: "modelMessageStopEvent",
      stopReason: "endTurn",
    });
  }
}

function makeAgent(
  nativeTools = [NATIVE_TOOL],
  agentsByThread = new Map<string, Agent>(),
  model = new ToolCallModel(),
) {
  const warn = vi.fn();
  const core = new Agent({
    model,
    tools: nativeTools,
    systemPrompt: "Call confirm_action.",
    printer: false,
  });
  const agent = new StrandsAgent({
    agent: core,
    name: "interrupt-client-tool-test",
    agentsByThread,
    config: {
      logger: { debug: vi.fn(), warn, error: vi.fn() },
      toolBehaviors: {
        [TOOL_NAME]: { interruptOnCall: true },
      },
    },
  });
  return { agent, agentsByThread, model, warn };
}

function input(runId: string, tools: AguiTool[]) {
  return minimalRunInput({
    threadId: THREAD_ID,
    runId,
    tools,
    messages: [
      {
        id: `user-${runId}`,
        role: "user",
        content: "Call confirm_action.",
      },
    ],
  });
}

function expectToolCallLifecycle(events: Awaited<ReturnType<typeof collect>>) {
  expect(
    events
      .filter((event) =>
        [
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
        ].includes(event.type),
      )
      .map((event) => event.type),
  ).toEqual([
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
  ]);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: EventType.TOOL_CALL_START,
        toolCallName: TOOL_NAME,
      }),
    ]),
  );
}

describe("interruptOnCall client-tool guard", () => {
  it("warns and skips the interrupt for a currently registered client proxy", async () => {
    const { agent, model, warn } = makeAgent([]);
    model.beginRun();

    const events = await collect(agent, input("run-1", [CLIENT_TOOL]));

    expectToolCallLifecycle(events);
    const finished = events.at(-1);
    expect(finished).toEqual(
      expect.objectContaining({ type: EventType.RUN_FINISHED }),
    );
    expect(finished).toHaveProperty("outcome", { type: "success" });
    expect(agent).toHaveProperty("_pendingInterruptsByThread", new Map());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TOOL_NAME));
  });

  it("still interrupts a backend tool with the same configured name", async () => {
    const { agent, model } = makeAgent();
    model.beginRun();

    const events = await collect(agent, input("run-1", []));

    const finished = events.at(-1);
    expect(finished).toEqual(
      expect.objectContaining({
        type: EventType.RUN_FINISHED,
        outcome: expect.objectContaining({ type: "interrupt" }),
      }),
    );
  });

  it("evaluates proxy membership when the hook fires on each request", async () => {
    const { agent, agentsByThread, model } = makeAgent([]);
    model.beginRun();

    const firstEvents = await collect(agent, input("run-1", [CLIENT_TOOL]));
    expect(firstEvents.at(-1)).toHaveProperty("outcome", { type: "success" });

    const liveAgent = agentsByThread.get(THREAD_ID);
    if (!liveAgent) {
      throw new Error(`No per-thread agent was created for ${THREAD_ID}`);
    }
    liveAgent.toolRegistry.remove(TOOL_NAME);
    liveAgent.toolRegistry.add(NATIVE_TOOL);
    const { agent: recreatedAgent } = makeAgent([], agentsByThread, model);
    model.beginRun();

    const secondEvents = await collect(recreatedAgent, input("run-2", []));

    expect(secondEvents.at(-1)).toEqual(
      expect.objectContaining({
        type: EventType.RUN_FINISHED,
        outcome: expect.objectContaining({ type: "interrupt" }),
      }),
    );
  });
});
