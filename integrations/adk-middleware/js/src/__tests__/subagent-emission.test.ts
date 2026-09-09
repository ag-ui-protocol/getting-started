import { EventType, type AGUIEvent } from "@ag-ui/core";
import {
  AgentTool,
  FunctionNode,
  InMemorySessionService,
  LlmAgent,
  Runner,
  requestInputTool,
  Workflow,
  type LlmResponse,
  type RunAsyncToolRequest,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSAgent } from "../index";
import { AG_UI_RUN_KEY } from "../constants";
import type { ADKJSSubagentMode } from "../config";
import { DeterministicLlm, collect, runInput, verified } from "./helpers";

const transferTo = (agentName: string): LlmResponse => ({
  content: {
    role: "model",
    parts: [
      { functionCall: { name: "transfer_to_agent", args: { agentName } } },
    ],
  },
});
const say = (text: string): LlmResponse => ({
  content: { role: "model", parts: [{ text }] },
});
const askUser = (message: string): LlmResponse => ({
  content: {
    role: "model",
    parts: [{ functionCall: { name: "adk_request_input", args: { message } } }],
  },
});

function bridge(
  mode: ADKJSSubagentMode,
  childResponses: LlmResponse[],
): { agent: ADKJSAgent; sessionService: InMemorySessionService } {
  const child = new LlmAgent({
    name: "child",
    description: "Answers detail questions",
    model: new DeterministicLlm(childResponses),
    tools: [requestInputTool],
  });
  const root = new LlmAgent({
    name: "root",
    model: new DeterministicLlm([transferTo("child")]),
    subAgents: [child],
  });
  const sessionService = new InMemorySessionService();
  return {
    sessionService,
    agent: new ADKJSAgent({
      runner: new Runner({ appName: "test-app", agent: root, sessionService }),
      userId: "user-1",
      subagents: mode,
    }),
  };
}

const startedIds = (events: AGUIEvent[]) =>
  events
    .filter((e) => e.type === EventType.SUBAGENT_STARTED)
    .map((e) => (e as { subagentRunId: string }).subagentRunId);

describe("ADKJSAgent subagent emission", () => {
  it("resumes a nested transfer without referring to a parent from a previous run", async () => {
    const child = new LlmAgent({
      name: "child",
      tools: [requestInputTool],
      model: new DeterministicLlm([askUser("Which report?"), say("Q3 report")]),
    });
    const parent = new LlmAgent({
      name: "parent",
      subAgents: [child],
      model: new DeterministicLlm([transferTo("child")]),
    });
    const agent = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new LlmAgent({
          name: "root",
          subAgents: [parent],
          model: new DeterministicLlm([transferTo("parent")]),
        }),
      }),
      userId: "user-1",
      subagents: "attributed",
    });
    const first = await collect(agent.clone(), runInput());
    const terminal = first.at(-1);
    if (
      terminal?.type !== EventType.RUN_FINISHED ||
      terminal.outcome?.type !== "interrupt"
    ) {
      throw new Error("Expected a child interrupt");
    }
    const interrupt = terminal.outcome.interrupts[0];
    await verified(first);
    const resumed = await collect(
      agent.clone(),
      runInput({
        runId: "run-2",
        resume: [
          { interruptId: interrupt.id, status: "resolved", payload: "Q3" },
        ],
      }),
    );
    expect(startedIds(resumed)).toEqual([interrupt.subagentRunId]);
    expect(resumed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    await verified(resumed);
  });

  it.each([true, false])(
    "closes and resumes an AgentTool approval (approved=%s)",
    async (approved) => {
      let executions = 0;
      class ApprovalTool extends AgentTool {
        override async checkRequireConfirmation() {
          return true;
        }
        override async runAsync(args: RunAsyncToolRequest): Promise<unknown> {
          if (!args.toolContext.toolConfirmation) {
            args.toolContext.requestConfirmation({ hint: "Delegate?" });
            return { pending: true };
          }
          if (!args.toolContext.toolConfirmation.confirmed)
            return { denied: true };
          executions++;
          return super.runAsync(args);
        }
      }
      const helper = new LlmAgent({
        name: "helper",
        model: new DeterministicLlm([say("delegated answer")]),
      });
      const agent = new ADKJSAgent({
        runner: new Runner({
          appName: "test-app",
          sessionService: new InMemorySessionService(),
          agent: new LlmAgent({
            name: "root",
            tools: [new ApprovalTool({ agent: helper })],
            model: new DeterministicLlm([
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: {
                        name: "helper",
                        args: { request: "Help" },
                      },
                    },
                  ],
                },
              },
              say("Done"),
            ]),
          }),
        }),
        userId: "user-1",
        subagents: "attributed",
      });
      const first = await collect(agent.clone(), runInput());
      const terminal = first.at(-1);
      if (
        terminal?.type !== EventType.RUN_FINISHED ||
        terminal.outcome?.type !== "interrupt"
      ) {
        throw new Error("Expected a delegation approval");
      }
      const [id] = startedIds(first);
      const interrupt = terminal.outcome.interrupts[0];
      expect(executions).toBe(0);
      expect(interrupt.subagentRunId).toBe(id);
      expect(
        first.find((e) => e.type === EventType.SUBAGENT_FINISHED),
      ).toMatchObject({
        subagentRunId: id,
        outcome: { type: "suspended", interruptIds: [interrupt.id] },
      });
      await verified(first);
      const resumed = await collect(
        agent.clone(),
        runInput({
          runId: "run-2",
          resume: [
            {
              interruptId: interrupt.id,
              status: "resolved",
              payload: { approved },
            },
          ],
        }),
      );
      expect(executions).toBe(approved ? 1 : 0);
      expect(startedIds(resumed)).toEqual([id]);
      expect(
        resumed.find((e) => e.type === EventType.SUBAGENT_FINISHED),
      ).toMatchObject({
        subagentRunId: id,
        outcome: { type: "success" },
      });
      await verified(resumed);
    },
  );

  it("attributes a workflow failure before the node emits any content", async () => {
    const agent = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Workflow({
          name: "workflow",
          edges: [
            [
              "START",
              new FunctionNode("failed", () => {
                throw new Error("node failed");
              }),
            ],
          ],
        }),
      }),
      userId: "user-1",
      subagents: "attributed",
    });
    const events = await collect(agent, runInput());
    const [id] = startedIds(events);
    expect(id).toEqual(expect.any(String));
    expect(
      events.find((e) => e.type === EventType.SUBAGENT_ERROR),
    ).toMatchObject({ subagentRunId: id, message: "node failed" });
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "node failed",
    });
    await verified(events);
  });

  it("attributes a transferred sub-agent's work and closes it before RUN_FINISHED", async () => {
    const { agent } = bridge("attributed", [say("child answer")]);
    const events = await collect(agent.clone(), runInput());

    const started = events.find((e) => e.type === EventType.SUBAGENT_STARTED);
    expect(started).toMatchObject({
      name: "child",
      description: "Answers detail questions",
      parentToolCallId: expect.any(String),
      parentMessageId: expect.any(String),
    });
    const id = (started as { subagentRunId: string }).subagentRunId;
    const childText = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_START && e.name === "child",
    );
    expect(childText).toMatchObject({ subagentRunId: id });
    // The transfer tool call itself belongs to the root and stays untagged.
    const transferCall = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(transferCall).not.toHaveProperty("subagentRunId");
    const types = events.map((e) => e.type);
    expect(types.indexOf(EventType.SUBAGENT_FINISHED)).toBeLessThan(
      types.indexOf(EventType.RUN_FINISHED),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    await verified(events);
  });

  it("emits no subagent surface at all in inline mode", async () => {
    const { agent } = bridge("off", [say("child answer")]);
    const events = await collect(agent.clone(), runInput());
    expect(JSON.stringify(events)).not.toContain("subagentRunId");
    expect(JSON.stringify(events)).not.toContain("SUBAGENT_");
    expect(
      events.some(
        (e) => e.type === EventType.TEXT_MESSAGE_START && e.name === "child",
      ),
    ).toBe(true);
    await verified(events);
  });

  it("re-announces a sub-agent under the same id when its interrupt is resumed", async () => {
    const { agent, sessionService } = bridge("attributed", [
      askUser("Which report?"),
      say("Here is the report"),
    ]);

    const first = await collect(agent.clone(), runInput());
    const finished = first.at(-1);
    if (
      finished?.type !== EventType.RUN_FINISHED ||
      finished.outcome?.type !== "interrupt"
    ) {
      throw new Error(
        "Expected the first run to pause on the child's interrupt.",
      );
    }
    const [childId] = startedIds(first);
    expect(finished.outcome.interrupts[0]).toMatchObject({
      subagentRunId: childId,
    });
    expect(
      first.find((e) => e.type === EventType.SUBAGENT_FINISHED),
    ).toMatchObject({
      subagentRunId: childId,
      outcome: {
        type: "suspended",
        interruptIds: [finished.outcome.interrupts[0].id],
      },
    });
    await verified(first);

    // The continuation is durable in the ADK session, not just in memory.
    const session = await sessionService.getSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: runInput().threadId,
    });
    expect(
      session?.events.some(
        (event) =>
          (
            event.customMetadata?.[AG_UI_RUN_KEY] as
              | { continuations?: unknown }
              | undefined
          )?.continuations !== undefined,
      ),
    ).toBe(true);

    const second = await collect(
      agent.clone(),
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: finished.outcome.interrupts[0].id,
            status: "resolved",
            payload: { report: "Q3" },
          },
        ],
      }),
    );
    expect(startedIds(second)).toEqual([childId]);
    expect(
      second.find(
        (e) => e.type === EventType.TEXT_MESSAGE_START && e.name === "child",
      ),
    ).toMatchObject({
      subagentRunId: childId,
    });
    expect(
      second.find((e) => e.type === EventType.SUBAGENT_FINISHED),
    ).toMatchObject({
      subagentRunId: childId,
      outcome: { type: "success" },
    });
    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    await verified(second);
  });
});
