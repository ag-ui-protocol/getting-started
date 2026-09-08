/**
 * The native interrupt path, driven through a genuine Strands `Agent`.
 *
 * Every other interrupt suite fabricates the interrupt: `Interrupt` is
 * exported from `@strands-agents/sdk` as a type only, so a plain
 * `{ id, name, reason }` object cast to `Interrupt` compiles, and a scripted
 * stub returns it in place of anything the SDK built. Those tests pin the
 * adapter's mapping, but they would stay green through a real break, and they
 * are free to invent details the SDK does not actually produce.
 *
 * Here the SDK constructs the interrupts. The only fake is the model, which
 * replays a scripted turn so no provider is called; the agent, the tool, the
 * interrupt, the resume handshake and the tool result are all real.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";
import { ScriptedModel } from "./strands-sdk-harness";

const TOOL_NAME = "confirm_delete";

function buildAdapter(): StrandsAgent {
  return buildAdapterWithSpy().adapter;
}

/** The adapter plus a record of every time the gated tool actually ran. */
function buildAdapterWithSpy(): { adapter: StrandsAgent; ran: string[] } {
  const ran: string[] = [];
  const confirmDelete = tool({
    name: TOOL_NAME,
    description: "Delete a path after confirmation",
    inputSchema: z.object({ path: z.string() }),
    callback: (input) => {
      ran.push(input.path);
      return { deleted: input.path };
    },
  });

  const template = new Agent({
    model: new ScriptedModel([
      { kind: "toolUse", name: TOOL_NAME, toolUseId: "tu-1", input: { path: "/tmp/x" } },
      { kind: "text", text: "all done" },
    ]),
    tools: [confirmDelete],
    printer: false,
  });

  const adapter = new StrandsAgent({
    agent: template,
    name: "t",
    config: { toolBehaviors: { [TOOL_NAME]: { interruptOnCall: true } } },
  });
  return { adapter, ran };
}

function resumeWith(interruptId: string, payload: unknown): RunAgentInput {
  return minimalRunInput({
    resume: [{ interruptId, status: "resolved", payload }],
  } as Partial<RunAgentInput>);
}

/** Whether the run ended with a plain successful RUN_FINISHED. */
function finishedSuccessfully(events: BaseEvent[]): boolean {
  const last = events.at(-1) as BaseEvent & { outcome?: { type?: string } };
  return (
    last?.type === EventType.RUN_FINISHED && last.outcome?.type !== "interrupt"
  );
}

/** Every tool result body on the wire, as emitted by the adapter. */
function toolResults(events: BaseEvent[]): string[] {
  return events
    .filter((e) => e.type === EventType.TOOL_CALL_RESULT)
    .map((e) => (e as BaseEvent & { content?: string }).content ?? "");
}

function interruptOutcome(events: BaseEvent[]) {
  const finished = events.at(-1) as BaseEvent & {
    outcome?: { type: string; interrupts?: Array<Record<string, unknown>> };
  };
  expect(finished.type).toBe(EventType.RUN_FINISHED);
  return finished.outcome;
}

describe("native interrupts against the real Strands SDK", () => {
  it("pauses on a real interrupt raised by the SDK", async () => {
    const adapter = buildAdapter();

    const outcome = interruptOutcome(await collect(adapter));

    expect(outcome?.type).toBe("interrupt");
    expect(outcome?.interrupts).toHaveLength(1);
    const [first] = outcome!.interrupts!;
    expect(first.reason).toBe("tool_call");
    expect((first.metadata as { strandsName?: string })?.strandsName).toBe(
      `ag_ui:tool_call:${TOOL_NAME}`,
    );
  });

  it("uses the interrupt id the SDK generates, not one of the adapter's own", async () => {
    // The SDK derives the id from the tool use it paused, and the fabricated
    // suites use flat ids like "int-1" that the SDK would never produce. If
    // that shape ever changes, cold-restart resume breaks, so pin it here
    // rather than trusting a hand-written literal.
    const adapter = buildAdapter();

    const outcome = interruptOutcome(await collect(adapter));
    const id = outcome!.interrupts![0].id as string;

    expect(id).toContain("tu-1");
    expect(id).toContain(TOOL_NAME);
  });

  it("carries the tool call id the interrupt paused", async () => {
    // The client correlates the approval prompt with the tool call it belongs
    // to through this field; without it the prompt cannot be attached to
    // anything on screen.
    const adapter = buildAdapter();

    const outcome = interruptOutcome(await collect(adapter));

    expect(outcome!.interrupts![0].toolCallId).toBe("tu-1");
  });

  it("registers the real interrupt id as pending on the thread", async () => {
    const adapter = buildAdapter();

    const outcome = interruptOutcome(await collect(adapter));
    const id = outcome!.interrupts![0].id as string;

    const pending = (
      adapter as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, unknown>>;
      }
    )._pendingInterruptsByThread.get("thread-1");
    expect(pending?.has(id)).toBe(true);
  });

  it("holds the tool until the interrupt is answered", async () => {
    // Pausing has to mean the tool body did not run, not merely that the
    // adapter emitted an interrupt event around it.
    const { adapter, ran } = buildAdapterWithSpy();

    interruptOutcome(await collect(adapter));

    expect(ran).toEqual([]);
  });

  it("runs the approved tool on resume and reports its result", async () => {
    const { adapter, ran } = buildAdapterWithSpy();

    const outcome = interruptOutcome(await collect(adapter));
    const id = outcome!.interrupts![0].id as string;

    const resumed = await collect(adapter, resumeWith(id, { approved: true }));

    expect(resumed.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);
    // Both that the body ran and that its result reached the wire. Asserting
    // only that the run finished cannot tell approval from denial.
    expect(ran).toEqual(["/tmp/x"]);
    expect(toolResults(resumed)).toContain(JSON.stringify({ deleted: "/tmp/x" }));
    expect(finishedSuccessfully(resumed)).toBe(true);
  });

  it("does not run the tool when the interrupt is denied", async () => {
    const { adapter, ran } = buildAdapterWithSpy();

    const outcome = interruptOutcome(await collect(adapter));
    const id = outcome!.interrupts![0].id as string;

    const resumed = await collect(adapter, resumeWith(id, { approved: false }));

    expect(resumed.map((e) => e.type)).not.toContain(EventType.RUN_ERROR);
    // Positive on both halves: the body never ran, and the run still finished
    // rather than stalling, so an adapter that emits nothing at all fails.
    expect(ran).toEqual([]);
    expect(finishedSuccessfully(resumed)).toBe(true);
  });

  it("rejects a resume for an id the SDK never issued", async () => {
    const adapter = buildAdapter();
    // Confirm the run really did pause first, or this passes for an adapter
    // that never raised an interrupt at all.
    interruptOutcome(await collect(adapter));

    // "int-1" is the shape the fabricated suites use; the SDK never mints it.
    const resumed = await collect(
      adapter,
      resumeWith("int-1", { approved: true }),
    );

    const error = resumed.find((e) => e.type === EventType.RUN_ERROR) as
      | (BaseEvent & { code?: string })
      | undefined;
    expect(error).toBeDefined();
    // The specific gate matters: any other RUN_ERROR would satisfy a bare
    // "an error happened" assertion while the guard itself was broken.
    expect(error?.code).toBe("UNKNOWN_INTERRUPT_ID");
  });
});
