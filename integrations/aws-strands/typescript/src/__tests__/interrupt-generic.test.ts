/**
 * Generic (non-tool-approval) native interrupts must stay generic.
 *
 * Interrupts NOT raised by the adapter's own interruptOnCall hook (which
 * always uses the "ag_ui:tool_call:" name prefix), e.g. a user's own tool
 * calling `context.interrupt()` directly for a generic human-in-the-loop
 * request, must be preserved as generic AG-UI interrupts, not misclassified
 * as tool-call approvals with fabricated schema/metadata.
 *
 * The interrupts here are raised by a real tool running inside the real
 * Strands agent loop, so the classification is exercised against interrupts
 * the SDK actually produced.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";

import {
  collect,
  expectNoRunError,
  finishedOf,
  interruptsOf,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
} from "./helpers";
import type { StrandsAgentConfig } from "../config";

const QUESTION = { question: "Which environment?" };

/** Bodies that ran only after a resume delivered a response, by tool name. */
const resumedBodies: string[] = [];
/** Resume responses the SDK handed back to the interrupted tool. */
const resumedResponses: unknown[] = [];

beforeEach(() => {
  resumedBodies.length = 0;
  resumedResponses.length = 0;
});

/** A user's own tool raising a generic HITL interrupt, not an approval. */
function clarifyingTool(name: string) {
  return tool({
    name,
    description: "Asks the operator which environment to use",
    inputSchema: z.object({}).passthrough(),
    callback: async (_input: unknown, context?: ToolContext) => {
      // `interrupt()` itself is synchronous and throws to suspend the run, so
      // nothing below it runs until a resume supplies a response.
      resumedResponses.push(
        context!.interrupt({ name: "need_clarification", reason: QUESTION }),
      );
      resumedBodies.push(name);
      return { clarified: true };
    },
  });
}

/** A tool that raises no interrupt of its own. */
function plainTool(name: string) {
  return tool({
    name,
    description: "Does the thing",
    inputSchema: z.object({}).passthrough(),
    callback: async () => ({ done: true }),
  });
}

async function runWith(
  toolName: string,
  config?: StrandsAgentConfig,
  toolFactory: (name: string) => ReturnType<typeof tool> = clarifyingTool,
) {
  const { agent } = realStrandsAgent(
    [
      modelTurn.toolUse({ toolUseId: "tu-1", name: toolName, input: {} }),
      modelTurn.text("done"),
    ],
    { tools: [toolFactory(toolName)], config },
  );
  const events = await collect(
    agent,
    minimalRunInput({
      messages: [{ id: "u1", role: "user", content: "deploy" } as never],
    }),
  );
  expectNoRunError(events);
  return { events, agent };
}

type Finished = BaseEvent & {
  outcome?: {
    type: string;
    interrupts?: {
      id: string;
      reason: string;
      responseSchema?: unknown;
      toolCallId?: string;
      metadata?: { reason?: unknown; strandsName?: string };
    }[];
  };
};

const firstInterrupt = (events: BaseEvent[]) =>
  interruptsOf(events)[0] as NonNullable<
    NonNullable<Finished["outcome"]>["interrupts"]
  >[number];

describe("Generic native interrupts (not raised by the adapter's own hook)", () => {
  it("preserves the native name as reason instead of fabricating tool_call", async () => {
    const interrupt = firstInterrupt((await runWith("ask_operator")).events);
    expect(interrupt.id).toBeTruthy();
    expect(interrupt.reason).toBe("need_clarification");
  });

  it("does not fabricate a tool-approval responseSchema or toolCallId", async () => {
    const interrupt = firstInterrupt((await runWith("ask_operator")).events);
    // An absence check cannot fail if the field is renamed, so responseSchema
    // is paired with the tool-approval test below, which asserts it IS
    // populated there. toolCallId has no such pair in this file.
    expect(interrupt.reason).toBe("need_clarification");
    expect(interrupt.responseSchema).toBeUndefined();
    expect(interrupt.toolCallId).toBeUndefined();
  });

  it("preserves the native reason payload in metadata", async () => {
    const interrupt = firstInterrupt((await runWith("ask_operator")).events);
    expect(interrupt.metadata?.reason).toEqual(QUESTION);
  });

  it("records the generic interrupt as pending so it can be resumed", async () => {
    const { agent, events } = await runWith("ask_operator");
    const interrupt = firstInterrupt(events);
    const pending = (
      agent as unknown as {
        _pendingInterruptsByThread: Map<string, Map<string, unknown>>;
      }
    )._pendingInterruptsByThread.get("thread-1");
    expect(
      pending,
      "generic interrupt was reported but not recorded",
    ).toBeDefined();
    expect(pending!.has(interrupt.id)).toBe(true);
  });

  it("resumes a generic interrupt and runs the rest of the tool", async () => {
    const { events, agent } = await runWith("ask_operator");
    const interrupt = firstInterrupt(events);

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u1", role: "user", content: "deploy" } as never],
        resume: [
          {
            interruptId: interrupt.id,
            status: "resolved",
            payload: { environment: "staging" },
          },
        ] as never,
      }),
    );

    // A generic interrupt has no responseSchema, so this also covers the
    // resume path where the payload gate has nothing to validate against.
    expectNoRunError(resumed, "generic resume");
    // A resume that was ignored would re-raise the interrupt and still finish
    // without error, so the interrupt-free finish is the load-bearing half.
    expect(
      finishedOf(resumed).outcome?.type,
      "the resume was ignored and the interrupt was raised again",
    ).not.toBe("interrupt");
    // And the tool body past the interrupt actually ran, with the payload the
    // client sent. Without this the round trip passes on a dropped payload.
    expect(resumedBodies).toEqual(["ask_operator"]);
    expect(resumedResponses).toEqual([{ environment: "staging" }]);
  });

  it("still classifies an ag_ui:tool_call:-named interrupt as a tool-call approval", async () => {
    // Sanity check: the adapter's own naming convention still produces the
    // tool-approval shape, unaffected by the generic path above. Uses a plain
    // tool so the approval hook is the only interrupt source in the run.
    const { events } = await runWith(
      "confirm_delete",
      { toolBehaviors: { confirm_delete: { interruptOnCall: true } } },
      plainTool,
    );
    const interrupt = firstInterrupt(events);
    expect(interrupt.reason).toBe("tool_call");
    expect(interrupt.responseSchema).toBeDefined();
    expect(interrupt.metadata?.strandsName).toBe(
      "ag_ui:tool_call:confirm_delete",
    );
  });
});
