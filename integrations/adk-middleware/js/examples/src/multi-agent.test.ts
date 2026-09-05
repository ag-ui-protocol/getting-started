import { verifyEvents } from "@ag-ui/client";
import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import {
  BaseLlm,
  FunctionNode,
  Workflow,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { createMultiAgentAgent } from "./multi-agent";
import { createDojoAgent } from "./factory";

class PipelineLlm extends BaseLlm {
  readonly inputs: { node: string; contents: unknown }[] = [];
  constructor() {
    super({ model: "pipeline-test" });
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const system = JSON.stringify(request.config?.systemInstruction ?? "");
    const node = /RESEARCHER/.test(system)
      ? "researcher"
      : /ANALYST/.test(system)
        ? "analyst"
        : "writer";
    this.inputs.push({ node, contents: structuredClone(request.contents) });
    const inputText = (request.contents ?? [])
      .filter((content) => content.role === "user")
      .flatMap((content) => content.parts ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
    const prefix =
      node === "researcher"
        ? "Research:"
        : node === "analyst"
          ? "Analysis:"
          : "Summary:";
    const text = `${prefix} ${inputText}`;
    yield { content: { role: "model", parts: [{ text }] } };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error("PipelineLlm does not support live mode.");
  }
}

function input(runId = "run-1"): RunAgentInput {
  return {
    threadId: "thread-1",
    runId,
    state: {},
    messages: [
      {
        id: `user-${runId}`,
        role: "user",
        content: "Research the benefits of remote work",
      },
    ],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

const NODES = ["researcher", "analyst", "writer"];

function describeStream(events: AGUIEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case EventType.STEP_STARTED:
      case EventType.STEP_FINISHED:
        return [`${event.type}:${event.stepName}`];
      case EventType.CUSTOM:
        return [`${event.type}:${event.name}:${JSON.stringify(event.value)}`];
      case EventType.TEXT_MESSAGE_START:
        return [`${event.type}:${event.name ?? "?"}`];
      case EventType.SUBAGENT_STARTED:
        return [`${event.type}:${event.name}`];
      default:
        return [];
    }
  });
}

async function verified(events: AGUIEvent[]): Promise<void> {
  await expect(
    lastValueFrom(from(events).pipe(verifyEvents(false), toArray())),
  ).resolves.toHaveLength(events.length);
}

describe("ADK-JS multi-agent workflow demo", () => {
  it("does not reuse mutable node instances across runs", async () => {
    const agent = createDojoAgent({
      name: "mutable-node",
      model: new PipelineLlm(),
      createRoot: () => {
        let calls = 0;
        return new Workflow({
          name: "workflow",
          edges: [["START", new FunctionNode("count", () => ++calls)]],
        });
      },
    });
    for (const runId of ["run-1", "run-2"]) {
      const events = await lastValueFrom(
        agent.clone().run(input(runId)).pipe(toArray()),
      );
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        result: 1,
      });
    }
  });

  it("drives the pipeline page contract: a step pair and one message per node, handoffs between them", async () => {
    const model = new PipelineLlm();
    const agent = createMultiAgentAgent({ model });
    const events = await lastValueFrom(agent.run(input()).pipe(toArray()));

    expect(describeStream(events)).toEqual([
      "STEP_STARTED:agent:researcher",
      "TEXT_MESSAGE_START:researcher",
      "STEP_FINISHED:agent:researcher",
      "STEP_STARTED:agent:analyst",
      'CUSTOM:MultiAgentHandoff:{"from_nodes":["researcher"],"to_nodes":["analyst"]}',
      "TEXT_MESSAGE_START:analyst",
      "STEP_FINISHED:agent:analyst",
      "STEP_STARTED:agent:writer",
      'CUSTOM:MultiAgentHandoff:{"from_nodes":["analyst"],"to_nodes":["writer"]}',
      "TEXT_MESSAGE_START:writer",
      "STEP_FINISHED:agent:writer",
    ]);
    const texts = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta);
    const topic = "Research the benefits of remote work";
    expect(texts).toEqual([
      `Research: ${topic}`,
      `Analysis: Research: ${topic}`,
      `Summary: Analysis: Research: ${topic}`,
    ]);
    expect(model.inputs).toEqual([
      {
        node: "researcher",
        contents: [{ role: "user", parts: [{ text: topic }] }],
      },
      {
        node: "analyst",
        contents: [{ role: "user", parts: [{ text: texts[0] }] }],
      },
      {
        node: "writer",
        contents: [{ role: "user", parts: [{ text: texts[1] }] }],
      },
    ]);
    // Default visibility is inline: no subagent surface reaches the Dojo.
    expect(JSON.stringify(events)).not.toContain("subagentRunId");
    expect(JSON.stringify(events)).not.toContain("SUBAGENT_");
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    await verified(events);
  });

  it("reports the same run through the subagent protocol when attributed", async () => {
    const agent = createMultiAgentAgent({
      model: new PipelineLlm(),
      subagents: "attributed",
    });
    const events = await lastValueFrom(agent.run(input()).pipe(toArray()));

    const started = events.filter((e) => e.type === EventType.SUBAGENT_STARTED);
    expect(started.map((e) => e.name)).toEqual(NODES);
    for (const [index, node] of NODES.entries()) {
      const id = (started[index] as { subagentRunId: string }).subagentRunId;
      const message = events.find(
        (e) => e.type === EventType.TEXT_MESSAGE_START && e.name === node,
      );
      expect(message).toMatchObject({ subagentRunId: id });
      expect(
        events.find(
          (e) =>
            e.type === EventType.SUBAGENT_FINISHED && e.subagentRunId === id,
        ),
      ).toMatchObject({ outcome: { type: "success" } });
    }
    const types = events.map((e) => e.type);
    expect(types.lastIndexOf(EventType.SUBAGENT_FINISHED)).toBeLessThan(
      types.indexOf(EventType.RUN_FINISHED),
    );
    await verified(events);
  });

  it("advertises the workflow's agents", async () => {
    const capabilities = await createMultiAgentAgent({
      model: new PipelineLlm(),
    }).getCapabilities();
    expect(capabilities.identity).toMatchObject({
      name: "adk_js_multi_agent",
      type: "google-adk-js",
    });
    expect(
      capabilities.multiAgent?.subAgents?.map((agent) => agent.name),
    ).toEqual(NODES);
  });

  it("keeps concurrent topics and subsequent runs separate at the model boundary", async () => {
    const model = new PipelineLlm();
    const agent = createMultiAgentAgent({ model });
    const run = async (topic: string, threadId: string, runId: string) => {
      const request = {
        ...input(runId),
        threadId,
        messages: [
          { id: `user-${runId}`, role: "user" as const, content: topic },
        ],
      };
      const events = await lastValueFrom(
        agent.clone().run(request).pipe(toArray()),
      );
      await verified(events);
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: "success" },
      });
      expect(
        events
          .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
          .map((e) => e.delta),
      ).toEqual([
        `Research: ${topic}`,
        `Analysis: Research: ${topic}`,
        `Summary: Analysis: Research: ${topic}`,
      ]);
    };
    await Promise.all([
      run("solar power", "solar", "run-1"),
      run("ocean tides", "ocean", "run-2"),
    ]);
    await run("wind turbines", "solar", "run-3");
    for (const topic of ["solar power", "ocean tides", "wind turbines"]) {
      const requests = model.inputs.filter((request) =>
        JSON.stringify(request.contents).includes(topic),
      );
      expect(requests.map((request) => request.node)).toEqual(NODES);
      expect(requests.map((request) => request.contents)).toEqual([
        [{ role: "user", parts: [{ text: topic }] }],
        [{ role: "user", parts: [{ text: `Research: ${topic}` }] }],
        [{ role: "user", parts: [{ text: `Analysis: Research: ${topic}` }] }],
      ]);
    }
  });
});
