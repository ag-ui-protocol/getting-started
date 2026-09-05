import {
  InMemorySessionService,
  LlmAgent,
  Runner,
  Workflow,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { discoverClientToolsets, indexAgentTree } from "../agent-tree";
import { ADKJSAgent, AGUIClientToolset } from "../index";

function tree(): { runner: Runner; toolset: AGUIClientToolset } {
  const toolset = new AGUIClientToolset();
  const grandchild = new LlmAgent({
    name: "grandchild",
    model: "gemini-2.5-flash",
    tools: [toolset],
  });
  const child = new LlmAgent({
    name: "child",
    description: "Handles child work",
    model: "gemini-2.5-flash",
    subAgents: [grandchild],
  });
  const root = new LlmAgent({
    name: "root",
    model: "gemini-2.5-flash",
    subAgents: [child],
  });
  return {
    toolset,
    runner: new Runner({
      appName: "test-app",
      agent: root,
      sessionService: new InMemorySessionService(),
    }),
  };
}

describe("ADK agent tree discovery", () => {
  it.each([false, true])(
    "advertises workflow nodes and frontend tools (factory=%s)",
    async (factory) => {
      const root = new Workflow({
        name: "pipeline",
        edges: [
          [
            "START",
            new LlmAgent({
              name: "researcher",
              description: "Researches",
              model: "m",
              tools: [new AGUIClientToolset()],
            }),
            new LlmAgent({ name: "writer", model: "m" }),
          ],
        ],
      });
      const runner = new Runner({
        appName: "test-app",
        agent: root,
        sessionService: new InMemorySessionService(),
      });
      const agent = new ADKJSAgent({
        userId: "u",
        ...(factory
          ? {
              appName: "test-app",
              sessionService: new InMemorySessionService(),
              agent: () => root,
            }
          : { runner }),
      });
      const capabilities = await agent.getCapabilities();
      expect(capabilities.multiAgent).toMatchObject({
        supported: true,
        subAgents: [
          { name: "researcher", description: "Researches" },
          { name: "writer" },
        ],
      });
      expect(capabilities.tools?.clientProvided).toBe(true);
    },
  );

  it("discovers a client toolset attached to a nested sub-agent", () => {
    const { runner, toolset } = tree();
    expect(discoverClientToolsets(runner)).toEqual([toolset]);
  });

  it("advertises direct sub-agents and omits ADK's empty default description", async () => {
    const { runner } = tree();
    const capabilities = await new ADKJSAgent({
      runner,
      userId: "u",
    }).getCapabilities();
    expect(capabilities.identity).toMatchObject({ name: "root" });
    expect(capabilities.identity).not.toHaveProperty("description");
    expect(capabilities.multiAgent).toMatchObject({
      supported: true,
      subAgents: [{ name: "child", description: "Handles child work" }],
    });
    expect(capabilities.multiAgent?.subAgents?.[0]).not.toHaveProperty(
      "description",
      "",
    );
  });

  it("indexes workflow nodes as agents but never the graph's START sentinel", () => {
    const writer = new LlmAgent({ name: "writer", model: "gemini-2.5-flash" });
    const workflow = new Workflow({ name: "wf", edges: [["START", writer]] });
    const index = indexAgentTree(workflow);
    expect(index.names.has("writer")).toBe(true);
    expect(index.names.has("__START__")).toBe(false);
    expect(index.parent.get("writer")).toBe("wf");
  });

  it("does not claim multi-agent support for a flat agent", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new LlmAgent({ name: "solo", model: "gemini-2.5-flash" }),
      sessionService: new InMemorySessionService(),
    });
    const capabilities = await new ADKJSAgent({
      runner,
      userId: "u",
    }).getCapabilities();
    expect(capabilities.multiAgent).toBeUndefined();
  });
});
