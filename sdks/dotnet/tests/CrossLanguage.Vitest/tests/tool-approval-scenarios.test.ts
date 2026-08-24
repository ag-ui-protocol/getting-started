import { describe, expect, it } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type RunFinishedEvent,
  type Tool,
} from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";

interface ToolCallStartEvent extends BaseEvent {
  toolCallId: string;
  toolCallName: string;
}

const clientTool: Tool = {
  name: "get_user_location",
  description: "Gets the user's current city.",
  parameters: { type: "object", properties: {} },
};

function collectText(events: BaseEvent[]): string {
  return events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event: any) => event.delta as string)
    .join("");
}

function finish(events: BaseEvent[]): RunFinishedEvent {
  return events.find((event) => event.type === EventType.RUN_FINISHED) as RunFinishedEvent;
}

describe("TS HttpAgent -> C# tool ownership and approval semantics", () => {
  it("client-only: surfaces the call without an interrupt and resumes from messages", async () => {
    const agent = new HttpAgent({
      url: `${baseUrl()}/tool_approval_scenarios/client-only`,
      threadId: "tool-approval-client-only",
      agentId: "cross-language-test",
    });
    agent.messages = [{ id: "u1", role: "user", content: "Where am I?" }];

    const turn1: BaseEvent[] = [];
    await agent.runAgent(
      { tools: [clientTool] },
      { onEvent: ({ event }) => turn1.push(event) },
    );

    const call = (turn1.filter(
      (event) => event.type === EventType.TOOL_CALL_START,
    ) as ToolCallStartEvent[]).find(
      (event) => event.toolCallName === clientTool.name,
    );
    expect(call).toBeDefined();
    expect(finish(turn1).outcome?.type).not.toBe("interrupt");
    expect(agent.pendingInterrupts).toEqual([]);

    agent.messages.push({
      id: "client-result",
      role: "tool",
      toolCallId: call!.toolCallId,
      content: "Tokyo, Japan",
    } as any);

    const turn2: BaseEvent[] = [];
    await agent.runAgent(
      { tools: [clientTool] },
      { onEvent: ({ event }) => turn2.push(event) },
    );

    expect(collectText(turn2)).toBe("completed:client-only");
    expect(agent.pendingInterrupts).toEqual([]);
  });

  it("server-only: executes and returns its result in one successful run", async () => {
    const agent = new HttpAgent({
      url: `${baseUrl()}/tool_approval_scenarios/server-only`,
      threadId: "tool-approval-server-only",
      agentId: "cross-language-test",
    });
    agent.messages = [{ id: "u1", role: "user", content: "Get the weather." }];

    const events: BaseEvent[] = [];
    await agent.runAgent(
      {},
      { onEvent: ({ event }) => events.push(event) },
    );

    expect(
      (events.filter(
        (event) => event.type === EventType.TOOL_CALL_START,
      ) as ToolCallStartEvent[]).some(
        (event) => event.toolCallName === "get_weather",
      ),
    ).toBe(true);
    expect(events.map((event) => event.type)).toContain(EventType.TOOL_CALL_RESULT);
    expect(collectText(events)).toBe("completed:server-only");
    expect(finish(events).outcome?.type).not.toBe("interrupt");
    expect(agent.pendingInterrupts).toEqual([]);
  });
});
