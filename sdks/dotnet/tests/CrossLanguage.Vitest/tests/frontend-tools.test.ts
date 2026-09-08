import { describe, it, expect } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type Tool } from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";

interface TextDeltaEvent extends BaseEvent {
  delta: string;
}

interface ToolCallStartEvent extends BaseEvent {
  toolCallId: string;
  toolCallName: string;
}

interface ToolCallArgsEvent extends BaseEvent {
  toolCallId: string;
  delta: string;
}

// Frontend tools live on the client: the client declares them in
// RunAgentInput.tools, the LLM emits a tool_call, and the server passes that
// call through to the client without executing it. The client is responsible
// for invoking the tool and (optionally) replying with the result. This test
// exercises the half of the loop the C# server is responsible for — accepting
// the tool definition, surfacing the LLM's tool_call, and not executing it.

function findToolCall(events: BaseEvent[], name: string): { start: ToolCallStartEvent; args: string } | null {
  const startEvents = events.filter(
    (e) => e.type === EventType.TOOL_CALL_START,
  ) as ToolCallStartEvent[];
  const start = startEvents.find((e) => e.toolCallName === name);
  if (!start) return null;
  const argsParts = events
    .filter((e): e is ToolCallArgsEvent =>
      e.type === EventType.TOOL_CALL_ARGS && (e as ToolCallArgsEvent).toolCallId === start.toolCallId)
    .map((e) => e.delta);
  return { start, args: argsParts.join("") };
}

describe("TS HttpAgent → C# AG-UI server (frontend tools)", () => {
  it("surfaces a client-declared tool call without executing it", async () => {
    const agent = new HttpAgent({
      url: `${baseUrl()}/agentic_chat`,
      threadId: "t-frontend-bg",
      agentId: "cross-language-test",
    });

    const changeBackground: Tool = {
      name: "change_background",
      description: "Change the background color of the page.",
      parameters: {
        type: "object",
        properties: { background: { type: "string" } },
        required: ["background"],
      },
    };

    agent.messages = [
      { id: "u1", role: "user", content: "Please set the background color to blue" },
    ];

    const events: BaseEvent[] = [];
    await agent.runAgent(
      { tools: [changeBackground] },
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    const call = findToolCall(events, "change_background");
    expect(call).not.toBeNull();
    expect(JSON.parse(call!.args)).toEqual({ background: "blue" });

    // Critically: there is no TOOL_CALL_RESULT — the server didn't execute
    // the tool. The client would invoke it on its end. RUN_FINISHED still
    // closes the run cleanly.
    const types = events.map((e) => e.type);
    expect(types).not.toContain(EventType.TOOL_CALL_RESULT);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("passes through a haiku-generation frontend tool call", async () => {
    const agent = new HttpAgent({
      url: `${baseUrl()}/agentic_chat`,
      threadId: "t-haiku",
      agentId: "cross-language-test",
    });

    const generateHaiku: Tool = {
      name: "generate_haiku",
      description: "Render a 3-line Japanese/English haiku card in the UI.",
      parameters: {
        type: "object",
        properties: {
          japanese: { type: "array", items: { type: "string" } },
          english: { type: "array", items: { type: "string" } },
          image_name: { type: "string" },
        },
        required: ["japanese", "english", "image_name"],
      },
    };

    agent.messages = [
      { id: "u1", role: "user", content: "Write me a haiku about the moon" },
    ];

    const events: BaseEvent[] = [];
    await agent.runAgent(
      { tools: [generateHaiku] },
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    const call = findToolCall(events, "generate_haiku");
    expect(call).not.toBeNull();
    const parsed = JSON.parse(call!.args) as {
      japanese: string[];
      english: string[];
      image_name: string;
    };
    expect(parsed.japanese).toHaveLength(3);
    expect(parsed.english).toHaveLength(3);
    expect(parsed.image_name).toBe("moon.png");

    expect(events.map((e) => e.type)).not.toContain(EventType.TOOL_CALL_RESULT);
  });
});
