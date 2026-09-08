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
  // Step01_GettingStarted.Server falls back to a deterministic FakeChatClient
  // when no Azure configuration is supplied — it answers any user message
  // with `(fake) You said: "{lastUserText}"`. That is precisely the round-trip
  // surface this cross-language test wants to exercise: the AG-UI wire format
  // and event sequence, not a specific LLM provider.
  server = await startStepServer({
    step: 1,
    projectName: "GettingStarted",
    port: 8101,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step01_GettingStarted.Server", () => {
  it("streams the canned fake response for a single greeting", async () => {
    // Mirrors the first turn of Step01's SampleClient.RunAsync:
    //   messages = [user "Hello"]; await GetStreamingResponseAsync(...)
    // The C# integration test asserts the same response shape via the .NET
    // AGUIChatClient; here we assert it via the TS HttpAgent.
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step01-greeting",
      agentId: "step01-cross-language",
    });
    agent.messages = [{ id: "u-greeting", role: "user", content: "Hello" }];

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
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);

    expect(collectText(events)).toBe('(fake) You said: "Hello"');
  });

  it("preserves multi-turn context across two runs", async () => {
    // Mirrors Step01's full SampleClient.RunAsync: two turns on the same
    // thread. After turn 1 HttpAgent appends the assistant reply to its
    // `messages` buffer; the user pushes a follow-up and runs again. The
    // server must accept the full prior history on the wire and respond
    // independently to the new user message.
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step01-multi-turn",
      agentId: "step01-cross-language",
    });

    agent.messages = [{ id: "u1", role: "user", content: "Hello" }];

    const turn1: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          turn1.push(event);
        },
      },
    );
    expect(collectText(turn1)).toBe('(fake) You said: "Hello"');

    agent.messages.push({ id: "u2", role: "user", content: "How are you?" });

    const turn2: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          turn2.push(event);
        },
      },
    );

    expect(collectText(turn2)).toBe('(fake) You said: "How are you?"');

    // Cross-turn shape sanity: each turn produces its own RUN_STARTED /
    // RUN_FINISHED bracket and at least one assistant TEXT_MESSAGE_CONTENT.
    for (const turn of [turn1, turn2]) {
      const types = turn.map((e) => e.type);
      expect(types).toContain(EventType.RUN_STARTED);
      expect(types).toContain(EventType.RUN_FINISHED);
      expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    }
  });
});
