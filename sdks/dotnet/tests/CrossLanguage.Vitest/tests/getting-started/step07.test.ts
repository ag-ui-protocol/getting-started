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

function collectThinking(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT)
    .map((e) => (e as TextDeltaEvent).delta)
    .join("");
}

let server: StepServerHandle;

beforeAll(async () => {
  // Step07 verifies that MEAI TextReasoningContent is mapped onto AG-UI's
  // REASONING_* event family by the hosting layer. The FakeChatClient
  // fallback emits both a TextReasoningContent and a TextContent in a
  // single update — the wire output should therefore include
  // REASONING_START, REASONING_MESSAGE_START/CONTENT/END, REASONING_END
  // plus the standard TEXT_MESSAGE_* events.
  server = await startStepServer({
    step: 7,
    projectName: "ThinkingEvents",
    port: 8107,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step07_ThinkingEvents.Server", () => {
  it("emits REASONING_* events alongside the TEXT_MESSAGE_* stream", async () => {
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step07",
      agentId: "step07-cross-language",
    });
    agent.messages = [
      { id: "u1", role: "user", content: "What is 15 * 23?" },
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
    expect(types).toContain(EventType.REASONING_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);

    expect(collectThinking(events)).toBe("Thinking about: What is 15 * 23?");
    expect(collectText(events)).toBe('(fake) You said: "What is 15 * 23?"');
  });
});
