import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunStartedEvent } from "@ag-ui/core";
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
  server = await startStepServer({
    step: 3,
    projectName: "FrontendTools",
    port: 8103,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step03_FrontendTools.Server", () => {
  it("accepts a client-declared tool and returns a streamed response", async () => {
    // Mirrors Step03's SampleClient: the user asks "What are some fun things
    // to do near me?" while declaring a frontend tool (GetUserLocation). The
    // wire contract is that client tools travel on RunAgentInput.tools and
    // the server passes them through to the LLM — but since we run with the
    // FakeChatClient fallback the LLM never invokes the tool. The test
    // therefore only asserts wire-shape compatibility for client tools.
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step03",
      agentId: "step03-cross-language",
    });
    agent.messages = [
      { id: "u1", role: "user", content: "What are some fun things to do near me?" },
    ];

    const events: BaseEvent[] = [];
    await agent.runAgent(
      {
        tools: [
          {
            name: "GetUserLocation",
            description: "Get the user's current location from GPS.",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        ],
      },
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
    expect(collectText(events)).toBe('(fake) You said: "What are some fun things to do near me?"');

    // No tool calls expected from the FakeChatClient. The cross-language
    // wire-compatibility surface is the request encoding (tools travel as
    // RunAgentInput.tools) and the response sequence — both validated here.
    expect(types).not.toContain(EventType.TOOL_CALL_START);

    const runStarted = events.find((e) => e.type === EventType.RUN_STARTED) as RunStartedEvent;
    expect(runStarted).toBeDefined();
  });
});
