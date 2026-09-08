import { describe, it, expect } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type Tool } from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";

interface ToolCallStartEvent extends BaseEvent {
  toolCallId: string;
  toolCallName: string;
}
interface ToolCallArgsEvent extends BaseEvent {
  toolCallId: string;
  delta: string;
}

function findToolCall(
  events: BaseEvent[],
  name: string,
): { toolCallId: string; args: string } | null {
  const start = (events.filter((e) => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent[]).find(
    (e) => e.toolCallName === name,
  );
  if (!start) return null;
  const args = events
    .filter((e): e is ToolCallArgsEvent =>
      e.type === EventType.TOOL_CALL_ARGS && (e as ToolCallArgsEvent).toolCallId === start.toolCallId)
    .map((e) => e.delta)
    .join("");
  return { toolCallId: start.toolCallId, args };
}

function collectText(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e: any) => e.delta as string)
    .join("");
}

// The mixed client+server tool dance is transparent to the client: it receives
// a TOOL_CALL for BOTH tools, executes only the tool it owns (get_user_location),
// and echoes back the assistant tool-call message plus its own tool result. The
// C# server resolves the server tool (get_weather) on its side. The client never
// distinguishes server vs client tools. This validates that round-trip over the
// wire from the TypeScript client.
describe("TS HttpAgent → C# AG-UI server (mixed client + server tools)", () => {
  it("resolves the server tool transparently while the client executes its own tool", async () => {
    const agent = new HttpAgent({
      url: `${baseUrl()}/backend_tool_rendering`,
      threadId: "t-mixed",
      agentId: "cross-language-test",
    });

    const getUserLocation: Tool = {
      name: "get_user_location",
      description: "Gets the user's current city via GPS.",
      parameters: { type: "object", properties: {} },
    };

    agent.messages = [
      { id: "u1", role: "user", content: "What is my current city and the forecast for Berlin?" },
    ];

    // Turn 1: both tools are surfaced as TOOL_CALLs; neither is resolved yet.
    const turn1: BaseEvent[] = [];
    await agent.runAgent({ tools: [getUserLocation] }, { onEvent: ({ event }) => { turn1.push(event); } });

    const weatherCall = findToolCall(turn1, "get_weather");
    const locationCall = findToolCall(turn1, "get_user_location");
    expect(weatherCall, "server tool get_weather should be surfaced").not.toBeNull();
    expect(locationCall, "client tool get_user_location should be surfaced").not.toBeNull();
    expect(turn1.map((e) => e.type)).not.toContain(EventType.TOOL_CALL_RESULT);

    // The client executes ONLY the tool it owns and echoes BOTH tool calls back,
    // with a result for its own tool. It does not know get_weather is server-side.
    const hasAssistant = agent.messages.some(
      (m: any) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
    );
    if (!hasAssistant) {
      agent.messages.push({
        id: "a1",
        role: "assistant",
        toolCalls: [
          { id: weatherCall!.toolCallId, type: "function", function: { name: "get_weather", arguments: weatherCall!.args } },
          { id: locationCall!.toolCallId, type: "function", function: { name: "get_user_location", arguments: locationCall!.args } },
        ],
      } as any);
    }
    agent.messages.push({
      id: "tr1",
      role: "tool",
      toolCallId: locationCall!.toolCallId,
      content: "Tokyo, Japan",
    } as any);

    // Turn 2: the server resolves get_weather transparently and returns the summary.
    const turn2: BaseEvent[] = [];
    await agent.runAgent({ tools: [getUserLocation] }, { onEvent: ({ event }) => { turn2.push(event); } });

    const types2 = turn2.map((e) => e.type);
    expect(types2).toContain(EventType.RUN_FINISHED);
    // get_weather was executed server-side on the continuation.
    expect(types2).toContain(EventType.TOOL_CALL_RESULT);

    const text = collectText(turn2);
    expect(text).toMatch(/Berlin/i);
    expect(text).toMatch(/Tokyo/i);
  });
});
