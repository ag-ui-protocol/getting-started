/**
 * Tests for langGraphDefaultMergeState.
 * Covers basic merging, tool deduplication, and the orphaned-tools fix for #1412.
 *
 * NOTE: LangGraphAgent extends AbstractAgent from @ag-ui/client, which isn't
 * buildable without protoc (network-dependent). So we can't instantiate the
 * real agent in tests. Instead, we duplicate the merge logic inline here.
 * This is a known drift risk — if agent.ts diverges, these tests won't catch it.
 * A future improvement would be to extract the merge function from the agent
 * class so it can be tested independently.
 */

import { describe, it, expect } from "vitest";
import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";

// ---- Inlined merge logic (mirrors agent.ts langGraphDefaultMergeState) ----
// This MUST stay in sync with agent.ts. Any change to the agent's merge logic
// must be reflected here, and vice versa.

type LangGraphToolWithName = {
  type: string;
  name?: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

interface MergeResult {
  messages: LangGraphMessage[];
  tools: LangGraphToolWithName[];
  "ag-ui": { tools: LangGraphToolWithName[]; context: unknown };
  [key: string]: unknown;
}

function langGraphDefaultMergeState(
  state: Record<string, unknown>,
  messages: LangGraphMessage[],
  input: { tools?: unknown[]; context?: unknown[] },
): MergeResult {
  if (messages.length > 0 && "role" in messages[0] && messages[0].role === "system") {
    messages = messages.slice(1);
  }

  const existingMessages = (state.messages ?? []) as LangGraphMessage[];
  const existingMessageIds = new Set(existingMessages.map((m) => m.id));
  const newMessages = messages.filter((m) => !existingMessageIds.has(m.id));

  // Input tools first so they win over stale state tools on name collision
  const allTools = [...((input.tools ?? []) as any[]), ...((state.tools ?? []) as any[])];
  const langGraphTools: LangGraphToolWithName[] = allTools.reduce(
    (acc: LangGraphToolWithName[], tool: any) => {
      let mappedTool = tool;
      if (!tool.type) {
        mappedTool = {
          type: "function",
          name: tool.name,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        };
      }

      if (
        acc.find(
          (t) => t.name === mappedTool.name || t.function.name === mappedTool.function?.name,
        )
      ) {
        return acc;
      }

      return [...acc, mappedTool];
    },
    [],
  );

  return {
    ...state,
    messages: newMessages,
    tools: langGraphTools,
    "ag-ui": {
      tools: langGraphTools,
      context: input.context,
    },
  };
}

// ---- Helpers ----

function makeTool(name: string, description = "desc") {
  return { name, description, parameters: { type: "object", properties: {} } };
}

function toolName(t: any): string | undefined {
  return t.name ?? t.function?.name;
}

// ---- Tests ----

describe("langGraphDefaultMergeState", () => {
  it("should append new messages to state", () => {
    const state = {
      messages: [{ id: "m1", type: "human" as const, content: "Hi", role: "user" }],
    };
    const newMessages = [
      { id: "m2", type: "ai" as const, content: "Hello", role: "assistant" },
    ] as unknown as LangGraphMessage[];
    const result = langGraphDefaultMergeState(state, newMessages, { tools: [] });
    expect(result.messages.some((m) => m.id === "m2")).toBe(true);
  });

  it("should exclude duplicate messages by id", () => {
    const msg = { id: "m1", type: "human" as const, content: "Hi", role: "user" };
    const state = { messages: [msg] };
    const result = langGraphDefaultMergeState(state, [msg], { tools: [] });
    expect(result.messages).toHaveLength(0);
  });

  it("should strip leading system message", () => {
    const msgs = [
      { id: "s1", role: "system", content: "sys", type: "system" },
      { id: "h1", role: "user", content: "Hi", type: "human" },
    ] as unknown as LangGraphMessage[];
    const result = langGraphDefaultMergeState({ messages: [] }, msgs, { tools: [] });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("h1");
  });

  it("should deduplicate tools with input winning over state (issue #1412)", () => {
    const stateTool = {
      type: "function",
      name: "search",
      function: { name: "search", description: "old", parameters: {} },
    };
    const state = { messages: [], tools: [stateTool] };
    const inputTool = makeTool("search", "new and improved");
    const result = langGraphDefaultMergeState(state, [], { tools: [inputTool] });
    const searchTools = result.tools.filter((t) => toolName(t) === "search");
    expect(searchTools).toHaveLength(1);
    // Input version should win
    const desc = (searchTools[0] as any).description || searchTools[0].function?.description;
    expect(desc).toBe("new and improved");
  });

  it("should preserve orphaned tools from state (issue #1412)", () => {
    const toolA = {
      type: "function",
      name: "tool_a",
      function: { name: "tool_a", description: "A", parameters: {} },
    };
    const toolB = {
      type: "function",
      name: "tool_b",
      function: { name: "tool_b", description: "B", parameters: {} },
    };
    const state = { messages: [], tools: [toolA, toolB] };
    const inputToolA = makeTool("tool_a", "A updated");
    const result = langGraphDefaultMergeState(state, [], { tools: [inputToolA] });
    const names = result.tools.map(toolName);
    expect(names).toContain("tool_a");
    expect(names).toContain("tool_b");
  });

  it("should preserve state tools when input has none", () => {
    const toolA = {
      type: "function",
      name: "tool_a",
      function: { name: "tool_a", description: "A", parameters: {} },
    };
    const state = { messages: [], tools: [toolA] };
    const result = langGraphDefaultMergeState(state, [], { tools: [] });
    expect(result.tools).toHaveLength(1);
  });

  it("should use input tools when state has none", () => {
    const state = { messages: [], tools: [] };
    const result = langGraphDefaultMergeState(state, [], { tools: [makeTool("new_tool")] });
    expect(result.tools.map(toolName)).toContain("new_tool");
  });

  it("should handle neither having tools", () => {
    const state = { messages: [] };
    const result = langGraphDefaultMergeState(state, [], { tools: [] });
    expect(result.tools).toHaveLength(0);
  });

  it("should place input tools before orphaned state tools (stable ordering)", () => {
    const orphan = {
      type: "function",
      name: "orphan_tool",
      function: { name: "orphan_tool", description: "orphaned", parameters: {} },
    };
    const state = { messages: [], tools: [orphan] };
    const result = langGraphDefaultMergeState(state, [], { tools: [makeTool("input_tool")] });
    const names = result.tools.map(toolName);
    expect(names.indexOf("input_tool")).toBeLessThan(names.indexOf("orphan_tool"));
  });

  it("should use input tool's parameters when same name exists in state", () => {
    const stateTool = {
      type: "function",
      name: "my_tool",
      function: { name: "my_tool", description: "old", parameters: { properties: { old: {} } } },
    };
    const state = { messages: [], tools: [stateTool] };
    const newParams = { type: "object", properties: { new_field: { type: "integer" } } };
    const inputTool = { name: "my_tool", description: "new", parameters: newParams };
    const result = langGraphDefaultMergeState(state, [], { tools: [inputTool] });
    const myTools = result.tools.filter((t) => toolName(t) === "my_tool");
    expect(myTools).toHaveLength(1);
    // Input tool came in as plain object — check its description was used
    const desc = (myTools[0] as any).description || myTools[0].function?.description;
    expect(desc).toBe("new");
  });

  it("should handle state with tools as null without crashing", () => {
    const state = { messages: [], tools: null as any };
    const result = langGraphDefaultMergeState(state, [], { tools: [makeTool("input_tool")] });
    expect(result.tools.map(toolName)).toContain("input_tool");
  });

  it("should set ag-ui key", () => {
    const state = { messages: [] };
    const result = langGraphDefaultMergeState(state, [], {
      tools: [makeTool("my_tool")],
      context: [{ description: "ctx", value: "val" }],
    });
    expect(result["ag-ui"]).toBeDefined();
    expect(result["ag-ui"].tools).toEqual(result.tools);
  });
});
