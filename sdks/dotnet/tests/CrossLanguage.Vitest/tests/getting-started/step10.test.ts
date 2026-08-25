import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type RunFinishedEvent,
} from "@ag-ui/core";
import { startStepServer, type StepServerHandle } from "../../helpers/step-server";

interface TextDeltaEvent extends BaseEvent {
  delta: string;
}

function collectText(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as TextDeltaEvent).delta)
    .join("");
}

let server: StepServerHandle;

beforeAll(async () => {
  // Step10's UserInputChatClient deterministically emits an
  // InterruptRequestContent with reason=input_required on the first turn,
  // and on resume reads the InterruptResponseContent payload to produce a
  // confirmation text. The hosting layer encodes this as RUN_FINISHED
  // outcome=interrupt + a reasoning-free response on the wire — exactly
  // what the TS HttpAgent should observe across the language boundary.
  server = await startStepServer({
    step: 10,
    projectName: "InterruptsUserInput",
    port: 8110,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step10_InterruptsUserInput.Server", () => {
  it("emits an input_required interrupt and resumes with the user's response", async () => {
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step10-userinput",
      agentId: "step10-cross-language",
    });
    agent.messages = [
      { id: "u1", role: "user", content: "Please setup my account" },
    ];

    // Turn 1: expect an input_required interrupt.
    const turn1: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          turn1.push(event);
        },
      },
    );

    const finish = turn1.find((e) => e.type === EventType.RUN_FINISHED) as RunFinishedEvent;
    expect(finish).toBeDefined();
    const outcome = finish.outcome as
      | { type: "success" }
      | {
          type: "interrupt";
          interrupts: Array<{
            id: string;
            reason: string;
            message?: string;
            responseSchema?: unknown;
          }>;
        };
    expect(outcome.type).toBe("interrupt");
    if (outcome.type !== "interrupt") return;
    const interrupt = outcome.interrupts[0]!;
    expect(interrupt.reason).toBe("input_required");
    expect(interrupt.message).toMatch(/username/i);
    expect(interrupt.responseSchema).toBeDefined();

    // Turn 2: resume with the requested data. The payload shape is
    // declared by the interrupt's responseSchema — `{ response: string }`
    // for Step10. The hosting layer decodes Resume.Payload into an
    // InterruptResponseContent for the inner UserInputChatClient.
    const turn2: BaseEvent[] = [];
    await agent.runAgent(
      {
        resume: [
          {
            interruptId: interrupt.id,
            status: "resolved",
            payload: { response: "johndoe42" },
          },
        ],
      },
      {
        onEvent: ({ event }) => {
          turn2.push(event);
        },
      },
    );

    const types2 = turn2.map((e) => e.type);
    expect(types2).toContain(EventType.RUN_STARTED);
    expect(types2).toContain(EventType.RUN_FINISHED);
    expect(types2).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(collectText(turn2)).toMatch(/johndoe42/);
  });
});
