import { describe, it, expect } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type RunFinishedEvent,
  type RunFinishedInterruptOutcome,
} from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";

interface CollectedRun {
  events: BaseEvent[];
  interruptId: string | null;
}

async function collect(agent: HttpAgent, params: Parameters<HttpAgent["runAgent"]>[0] = {}): Promise<CollectedRun> {
  const events: BaseEvent[] = [];
  await agent.runAgent(params, {
    onEvent: ({ event }) => {
      events.push(event);
    },
  });
  const runFinished = events.find(
    (e): e is RunFinishedEvent => e.type === EventType.RUN_FINISHED,
  );
  const outcome = runFinished?.outcome;
  const interruptId =
    outcome && outcome.type === "interrupt" && outcome.interrupts.length > 0
      ? (outcome as RunFinishedInterruptOutcome).interrupts[0]!.id
      : null;
  return { events, interruptId };
}

describe("TS HttpAgent → C# AG-UI server (human_in_the_loop)", () => {
  it("surfaces an interrupt then accepts the approved-resume payload", async () => {
    // First turn: C# server proposes a plan and finishes with an interrupt
    // outcome. The TS HttpAgent must surface the interrupt id so the client
    // can decide how to respond.
    const agent = new HttpAgent({
      url: `${baseUrl()}/human_in_the_loop`,
      threadId: "t-hitl-approve",
      agentId: "cross-language-test",
    });
    agent.messages = [{ id: "u1", role: "user", content: "Propose a baking plan" }];

    const firstRun = await collect(agent);

    expect(firstRun.events.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
    expect(firstRun.interruptId).toBe("interrupt-plan-approval");

    const planText = firstRun.events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e: any) => e.delta as string)
      .join("");
    expect(planText).toContain("gather ingredients");

    // Second turn: post a resume payload with approved=true. The server
    // sees input.Resume populated and continues with a confirmation.
    agent.messages.push({
      id: "u2",
      role: "user",
      content: "Yes, go ahead",
    });
    const secondRun = await collect(agent, {
      resume: [
        {
          interruptId: firstRun.interruptId!,
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });

    expect(secondRun.interruptId).toBeNull();
    const confirmText = secondRun.events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e: any) => e.delta as string)
      .join("");
    expect(confirmText).toContain("Approved");
  });

  it("relays a rejected resume payload back to the user", async () => {
    // Same as above but the client rejects the plan. The server must read
    // approved=false out of the resume payload and emit the rejection text.
    const agent = new HttpAgent({
      url: `${baseUrl()}/human_in_the_loop`,
      threadId: "t-hitl-reject",
      agentId: "cross-language-test",
    });
    agent.messages = [{ id: "u1", role: "user", content: "Propose a baking plan" }];

    const firstRun = await collect(agent);
    expect(firstRun.interruptId).toBe("interrupt-plan-approval");

    agent.messages.push({ id: "u2", role: "user", content: "Actually, no" });
    const secondRun = await collect(agent, {
      resume: [
        {
          interruptId: firstRun.interruptId!,
          status: "resolved",
          payload: { approved: false },
        },
      ],
    });

    const text = secondRun.events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e: any) => e.delta as string)
      .join("");
    expect(text).toContain("rejected");
  });
});
