/**
 * Every RUN_FINISHED reports how the run ended. A client switching on
 * `outcome.type` has to work on the ordinary path too, not only on the
 * interrupt and resume paths that already reported one.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import {
  collect,
  expectNoRunError,
  finishedOf,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  recordingTool,
} from "./helpers";

/**
 * Pin the success outcome only alongside the observation that proves the run
 * actually reached the scenario the test is named for. Both arguments are
 * required, so a caller cannot pin the outcome of a run that never got there:
 * every one of these outcomes is also what an empty or short-circuited run
 * reports.
 */
function expectSuccessAfter(
  events: BaseEvent[],
  premise: { what: string; observed: unknown; expected: unknown },
): void {
  expect(
    premise.observed,
    `the run never ${premise.what}, so its outcome pins nothing`,
  ).toEqual(premise.expected);
  expectNoRunError(events);
  expect(finishedOf(events).outcome).toEqual({ type: "success" });
}

/** Assistant text the run streamed, concatenated in emission order. */
function streamedText(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as BaseEvent & { delta: string }).delta)
    .join("");
}

/** Names of the steps the run opened, in order. */
function startedSteps(events: BaseEvent[]): string[] {
  return events
    .filter((e) => e.type === EventType.STEP_STARTED)
    .map((e) => (e as BaseEvent & { stepName: string }).stepName);
}

/**
 * Orchestrator shape: `.stream()` but no `.model`, which is how the
 * constructor discriminates a Graph/Swarm from an Agent.
 */
function fakeOrchestrator(events: unknown[]) {
  return {
    id: "test-graph",
    async *stream(_input: string) {
      for (const e of events) yield e;
    },
  };
}

const userTurn = () =>
  minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "go" } as never],
  });

describe("RUN_FINISHED outcome", () => {
  it("reports success on a plain single-agent run", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("hi")]);

    const finished = finishedOf(await collect(agent, userTurn()));

    expect(finished.outcome).toEqual({ type: "success" });
  });

  it("reports success on a run that called a backend tool", async () => {
    const { tool, calls } = recordingTool("get_cell");
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({
          toolUseId: "tu-1",
          name: "get_cell",
          input: { cell: "B4" },
        }),
        modelTurn.text("done"),
      ],
      { tools: [tool] },
    );

    const events = await collect(agent, userTurn());

    expectSuccessAfter(events, {
      what: "ran the backend tool",
      observed: calls,
      expected: [{ cell: "B4" }],
    });
  });

  it("reports success on the orchestrator path", async () => {
    const orchestrator = fakeOrchestrator([
      { type: "beforeNodeCallEvent", nodeId: "researcher" },
      {
        type: "nodeStreamUpdateEvent",
        nodeId: "researcher",
        inner: {
          source: "agent",
          event: {
            type: "modelContentBlockDeltaEvent",
            delta: { type: "textDelta", text: "Found it." },
          },
        },
      },
      // `AfterNodeCallEvent` carries no `nodeType` on SDK 1.1.0 (only
      // `NodeStreamUpdateEvent` does), so neither does the fixture.
      { type: "afterNodeCallEvent", nodeId: "researcher" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = new StrandsAgent({ agent: orchestrator as any, name: "t" });

    const events = await collect(agent);

    expectSuccessAfter(events, {
      what: "translated the scripted node events onto the wire",
      observed: { steps: startedSteps(events), text: streamedText(events) },
      expected: { steps: ["agent:researcher"], text: "Found it." },
    });
  });
});
