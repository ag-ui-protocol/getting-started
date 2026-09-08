import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
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
  // Step04 demonstrates the pre-interrupt approval pattern via a paired
  // pair of DelegatingChatClient wrappers: the server's ApprovalChatClient
  // converts MEAI ToolApprovalRequestContent emitted by an LLM into a
  // synthetic `request_approval` frontend tool call. With the FakeChatClient
  // fallback no LLM is involved and no approval is emitted — the wire
  // contract is therefore exercised by sending a normal user message and
  // verifying the server still returns a well-formed AG-UI event stream.
  server = await startStepServer({
    step: 4,
    projectName: "HumanInLoop",
    port: 8104,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step04_HumanInLoop.Server", () => {
  it("returns a well-formed event stream for a normal user message", async () => {
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step04",
      agentId: "step04-cross-language",
    });
    agent.messages = [
      { id: "u1", role: "user", content: "Please approve expense report EXP-2024-001" },
    ];

    const events: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(collectText(events)).toBe('(fake) You said: "Please approve expense report EXP-2024-001"');
  });
});
