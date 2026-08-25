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
  // Step09 wires `delete_file` as an ApprovalRequiredAIFunction; the
  // FakeChatClient fallback is intentionally written to emit a
  // FunctionCallContent for delete_file on the first turn so FICC produces
  // a ToolApprovalRequestContent that the hosting layer renders as an
  // AG-UI RUN_FINISHED { outcome: interrupt, reason: "tool_call" }. On
  // resume with a tool-approval-shaped resume payload, the SDK injects
  // the matching ToolApprovalRequest/Response pair so FICC executes the
  // function and the FakeChatClient then emits its `(fake) acknowledged`
  // text. That is the full cross-language approval round-trip.
  server = await startStepServer({
    step: 9,
    projectName: "InterruptsApproval",
    port: 8109,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step09_InterruptsApproval.Server", () => {
  it("emits a tool-call interrupt and resumes after approval", async () => {
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step09-approval",
      agentId: "step09-cross-language",
    });
    agent.messages = [
      { id: "u1", role: "user", content: "Please delete the file /etc/important.conf" },
    ];

    // Turn 1: expect a tool-call interrupt.
    const turn1: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          turn1.push(event);
        },
      },
    );

    const types1 = turn1.map((e) => e.type);
    expect(types1).toContain(EventType.RUN_STARTED);
    expect(types1).toContain(EventType.TOOL_CALL_START);
    expect(types1).toContain(EventType.TOOL_CALL_END);

    const finish = turn1.find((e) => e.type === EventType.RUN_FINISHED) as RunFinishedEvent;
    expect(finish).toBeDefined();
    const outcome = finish.outcome as
      | { type: "success" }
      | {
          type: "interrupt";
          interrupts: Array<{
            id: string;
            reason: string;
            toolCallId?: string;
          }>;
        };
    expect(outcome.type).toBe("interrupt");
    if (outcome.type !== "interrupt") return;
    expect(outcome.interrupts).toHaveLength(1);
    const interrupt = outcome.interrupts[0]!;
    expect(interrupt.reason).toBe("tool_call");
    expect(interrupt.toolCallId).toBe("call_delete1");

    // Turn 2: resume with a tool-approval-shaped payload. The C# SDK
    // detects the `toolCall` field and reconstructs the matching MEAI
    // ToolApprovalRequest/Response pair so FICC executes delete_file and
    // the FakeChatClient emits its acknowledgement text.
    const turn2: BaseEvent[] = [];
    await agent.runAgent(
      {
        resume: [
          {
            interruptId: interrupt.id,
            status: "resolved",
            payload: {
              approved: true,
              toolCall: {
                callId: "call_delete1",
                name: "delete_file",
                arguments: { filename: "/tmp/example.txt" },
              },
            },
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
    expect(collectText(turn2)).toContain("(fake) acknowledged:");
  });
});
