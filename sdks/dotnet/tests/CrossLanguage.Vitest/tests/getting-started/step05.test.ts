import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type StateSnapshotEvent,
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
  // Step05 wires a RecipeStateChatClient between the canonical AG-UI
  // endpoint and the underlying IChatClient. When RunAgentInput.state is a
  // non-empty object, the wrapper switches into "recipe state" mode: it
  // asks the LLM for a structured AgentState (returned as a STATE_SNAPSHOT
  // event), then asks for a follow-up summary text. The FakeChatClient
  // fallback handles the JSON-schema-formatted request by returning a
  // canned recipe object; the second non-JSON request returns the standard
  // (fake) text. That gives us a realistic STATE_SNAPSHOT + text round-
  // trip without depending on a real LLM.
  server = await startStepServer({
    step: 5,
    projectName: "StateManagement",
    port: 8105,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step05_StateManagement.Server", () => {
  it("emits STATE_SNAPSHOT plus follow-up text when initial state is supplied", async () => {
    // Mirrors Step05's SampleClient: the user asks for a pasta recipe and
    // sends an empty-recipe state shell. The server fills it in and emits
    // a STATE_SNAPSHOT event followed by a summary text.
    const initialState = {
      recipe: {
        title: "",
        cuisine: "",
        ingredients: [] as string[],
        steps: [] as string[],
        prep_time_minutes: 0,
        cook_time_minutes: 0,
        skill_level: "",
      },
    };

    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step05",
      agentId: "step05-cross-language",
      initialState,
    });
    agent.messages = [
      { id: "u1", role: "user", content: "Suggest me an Italian pasta recipe" },
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
    expect(types).toContain(EventType.STATE_SNAPSHOT);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);

    const snapshot = events.find((e) => e.type === EventType.STATE_SNAPSHOT) as StateSnapshotEvent;
    expect(snapshot).toBeDefined();
    const state = snapshot.snapshot as { recipe?: { title?: string; ingredients?: unknown[] } };
    expect(state.recipe?.title).toBe("Spaghetti al Pomodoro");
    expect(state.recipe?.ingredients?.length).toBeGreaterThan(0);

    expect(collectText(events).length).toBeGreaterThan(0);
  });
});
