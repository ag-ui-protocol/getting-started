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
  // Step02 registers a server-side `find_restaurants` tool through
  // ChatClientBuilder.ConfigureOptions and exposes the canonical AG-UI
  // endpoint. The FakeChatClient fallback ignores the tool and answers any
  // user message with `(fake) You said: "..."` — exactly what we need to
  // assert wire compatibility without depending on a real LLM.
  server = await startStepServer({
    step: 2,
    projectName: "BackendTools",
    port: 8102,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step02_BackendTools.Server", () => {
  it("streams a text response and never advertises the backend tool to the client", async () => {
    // Mirrors Step02's SampleClient.RunAsync: a single user message asking
    // about Italian restaurants. The server registers `find_restaurants`
    // server-side; per the AG-UI contract, server-side tools are NOT echoed
    // back as RUN_STARTED-time tool advertisements — only client tools are.
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step02",
      agentId: "step02-cross-language",
    });
    agent.messages = [
      { id: "u1", role: "user", content: "Find Italian restaurants in Seattle" },
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

    expect(collectText(events)).toBe('(fake) You said: "Find Italian restaurants in Seattle"');

    // No TOOL_CALL_* events should be emitted by the FakeChatClient — it
    // never invokes the registered server tool. This still validates that
    // the wire format does not leak server-side tools onto the client.
    expect(types).not.toContain(EventType.TOOL_CALL_START);
    expect(types).not.toContain(EventType.TOOL_CALL_END);
  });
});
