import { describe, it, expect } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";

interface ToolCallStartEvent extends BaseEvent {
  toolCallId: string;
  toolCallName: string;
}

function toolCallNames(events: BaseEvent[]): string[] {
  return (events.filter((e) => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[]).map(
    (e) => e.toolCallName,
  );
}

function collectText(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e: any) => e.delta as string)
    .join("");
}

// A single user prompt elicits TWO parallel server-side tool calls (get_weather +
// get_current_time) in one assistant turn. The C# server resolves BOTH tools via
// FunctionInvokingChatClient, re-invokes the LLM with both tool results, and streams
// the final summary. This is fully transparent to the TS client — it never sends a
// tool result of its own — so it validates the parallel-tool-result conversion path
// (two FunctionResultContents -> two AGUIToolMessages keyed on distinct call ids and
// back) end to end across the language boundary.
describe("TS HttpAgent → C# AG-UI server (parallel server tools)", () => {
  it("resolves two parallel server tool calls in one turn", async () => {
    const agent = new HttpAgent({
      url: `${baseUrl()}/parallel_tool_calls`,
      threadId: "t-parallel",
      agentId: "cross-language-test",
    });

    agent.messages = [
      {
        id: "u1",
        role: "user",
        content: "Tell me the current weather in Madrid and what time it is in Cairo right now.",
      },
    ];

    const events: BaseEvent[] = [];
    await agent.runAgent({}, { onEvent: ({ event }) => { events.push(event); } });

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);

    // Both server tools must be surfaced as tool calls and resolved server-side.
    const names = toolCallNames(events);
    expect(names).toContain("get_weather");
    expect(names).toContain("get_current_time");

    // Each resolved tool emits a TOOL_CALL_RESULT keyed on its own (distinct) call id.
    const resultEvents = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(resultEvents.length).toBeGreaterThanOrEqual(2);
    const resultCallIds = new Set(resultEvents.map((e: any) => e.toolCallId as string));
    expect(resultCallIds.size).toBeGreaterThanOrEqual(2);

    // The final summary reflects both parallel results.
    const text = collectText(events);
    expect(text).toMatch(/Madrid/i);
    expect(text).toMatch(/Cairo/i);
  });
});
