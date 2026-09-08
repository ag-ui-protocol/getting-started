import { describe, it, expect } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";

async function run(userMessage: string, threadId: string): Promise<BaseEvent[]> {
  const agent = new HttpAgent({
    url: `${baseUrl()}/backend_tool_rendering`,
    threadId,
    agentId: "cross-language-test",
  });
  agent.messages = [{ id: `u-${threadId}`, role: "user", content: userMessage }];
  const events: BaseEvent[] = [];
  await agent.runAgent(
    {},
    {
      onEvent: ({ event }) => {
        events.push(event);
      },
    },
  );
  return events;
}

describe("TS HttpAgent → C# AG-UI server (backend_tool_rendering)", () => {
  it("executes a server-side tool round-trip", async () => {
    // The aimock fixture replies to "weather in Paris" with a tool_call for
    // get_weather; the C# server invokes its server-side tool, sends the tool
    // result back to the LLM, which then returns the canned summary text.
    // This validates the full tool round-trip (LLM → tool call event → tool
    // execution → result event → follow-up text) across the language boundary.
    const events = await run("What is the weather in Paris?", "t-tool");

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_END);

    const text = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e: any) => e.delta as string)
      .join("");
    expect(text).toMatch(/Paris/i);
    expect(text).toMatch(/72|sunny/i);

    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;
    expect(toolStart?.toolCallName).toBe("get_weather");
  });

  it.each([
    { city: "San Francisco", followUp: /foggy/i },
    { city: "New York", followUp: /overcast/i },
  ])("invokes get_weather for $city", async ({ city, followUp }) => {
    // Same scenario as the existing test, but parameterised by location to
    // prove the LLM-emitted arguments make it through unmodified and that
    // multiple distinct fixtures resolve independently. Mirrors the dojo's
    // backendToolRenderingPage spec which asserts SF + NYC suggestion cards.
    const events = await run(`Weather in ${city}`, `t-tool-${city.replace(/\s+/g, "-").toLowerCase()}`);

    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;
    expect(toolStart?.toolCallName).toBe("get_weather");

    const argsDelta = events
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
      .map((e: any) => e.delta as string)
      .join("");
    expect(JSON.parse(argsDelta)).toEqual({ location: city });

    const text = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e: any) => e.delta as string)
      .join("");
    expect(text).toMatch(followUp);
  });
});

