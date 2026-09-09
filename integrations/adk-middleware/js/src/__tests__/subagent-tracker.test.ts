import { EventType, type AGUIEvent, type Interrupt } from "@ag-ui/core";
import {
  AgentTool,
  LlmAgent,
  createEvent,
  createNodeErrorEvent,
  type Event as AdkEvent,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { indexAgentTree } from "../agent-tree";
import { ADKJSProtocolError } from "../errors";
import {
  ADKEventTranslator,
  type TranslatorSubagentOptions,
} from "../event-translator";
import type { SubagentContinuation } from "../subagent-tracker";
import { requestInputEvent, verified } from "./helpers";

// A static tree the tracker can resolve parents against. Containers such as
// `pipeline` never author events, exactly like ADK's Sequential/Parallel.
const TREE = {
  name: "root",
  subAgents: [
    { name: "a", description: "Agent A", subAgents: [{ name: "b" }] },
    { name: "pipeline", subAgents: [{ name: "x" }, { name: "y" }] },
  ],
};

function translator(
  overrides: Partial<TranslatorSubagentOptions> = {},
): ADKEventTranslator {
  return new ADKEventTranslator({}, false, "google", {
    tree: indexAgentTree(TREE),
    mode: "attributed",
    ...overrides,
  });
}

function text(params: {
  author?: string;
  text: string;
  id?: string;
  branch?: string;
  path?: string;
  partial?: boolean;
  stateDelta?: Record<string, unknown>;
  output?: unknown;
}): AdkEvent {
  return createEvent({
    id: params.id ?? `${params.author ?? "anon"}:${params.text}`,
    invocationId: "inv-1",
    author: params.author,
    branch: params.branch,
    ...(params.path ? { nodeInfo: { path: params.path } } : {}),
    ...(params.output !== undefined ? { output: params.output } : {}),
    partial: params.partial ?? false,
    content: { role: "model", parts: [{ text: params.text }] },
    actions: params.stateDelta ? { stateDelta: params.stateDelta } : undefined,
  });
}

function requestInput(author: string, id: string, path?: string): AdkEvent {
  return requestInputEvent({
    eventId: `${author}:${id}`,
    invocationId: "inv-1",
    author,
    path,
    id,
    message: "Which one?",
  });
}

function transfer(source: string, target: string, callId: string): AdkEvent[] {
  return [
    createEvent({
      id: `${source}:call:${callId}`,
      invocationId: "inv-1",
      author: source,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: callId,
              name: "transfer_to_agent",
              args: { agentName: target },
            },
          },
        ],
      },
    }),
    createEvent({
      id: `${source}:resp:${callId}`,
      invocationId: "inv-1",
      author: source,
      content: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: callId,
              name: "transfer_to_agent",
              response: {},
            },
          },
        ],
      },
      actions: { transferToAgent: target },
    }),
  ];
}

function run(
  t: ADKEventTranslator,
  events: readonly AdkEvent[],
): {
  stream: AGUIEvent[];
  interrupts: Interrupt[];
  owners: ReadonlyMap<string, SubagentContinuation>;
} {
  const stream: AGUIEvent[] = [];
  const raised: Interrupt[] = [];
  for (const event of events) {
    stream.push(...t.translate(event));
    for (const part of event.content?.parts ?? []) {
      if (
        part.functionCall?.name === "adk_request_input" &&
        part.functionCall.id
      ) {
        raised.push({ id: part.functionCall.id, reason: "input_required" });
      }
    }
  }
  const finished = t.finish();
  stream.push(...finished.events);
  const owners = finished.interruptOwners;
  const interrupts = raised.map((interrupt) => {
    const owner = owners.get(interrupt.id);
    return owner
      ? { ...interrupt, subagentRunId: owner.subagentRunId }
      : interrupt;
  });
  return { stream, interrupts, owners };
}

/** The tracker emits the body of a run; wrap it in a lifecycle and verify. */
async function verifiedRun(stream: AGUIEvent[], interrupts: Interrupt[] = []) {
  await verified([
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
    ...stream,
    {
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "r",
      outcome:
        interrupts.length > 0
          ? { type: "interrupt", interrupts }
          : { type: "success" },
    },
  ]);
}

const types = (stream: AGUIEvent[]) => stream.map((event) => event.type);
const lifecycle = (stream: AGUIEvent[]) =>
  stream
    .filter((event) =>
      [
        EventType.SUBAGENT_STARTED,
        EventType.SUBAGENT_FINISHED,
        EventType.SUBAGENT_ERROR,
      ].includes(event.type),
    )
    .map(
      (event) =>
        `${event.type}:${(event as { subagentRunId: string }).subagentRunId}`,
    );
const tagsOf = (stream: AGUIEvent[]) =>
  stream.map((event) => (event as { subagentRunId?: string }).subagentRunId);

describe("subagent lifecycle tracking", () => {
  it("does not announce unknown, root, or user authors", async () => {
    const { stream } = run(translator(), [
      text({ author: "model", text: "early exit" }),
      text({ author: undefined, text: "anonymous" }),
      text({ author: "root", text: "parent" }),
    ]);
    expect(lifecycle(stream)).toEqual([]);
    expect(tagsOf(stream).every((tag) => tag === undefined)).toBe(true);
    await verifiedRun(stream);
  });

  it("emits SUBAGENT_STARTED before a tagged STATE_DELTA on the sub-agent's first event", async () => {
    const { stream } = run(translator(), [
      text({ author: "a", text: "hello", stateDelta: { step: 1 } }),
    ]);
    expect(types(stream).slice(0, 4)).toEqual([
      EventType.SUBAGENT_STARTED,
      EventType.STEP_STARTED,
      EventType.STATE_DELTA,
      EventType.TEXT_MESSAGE_START,
    ]);
    expect(stream[0]).toMatchObject({ name: "a", description: "Agent A" });
    const id = (stream[0] as { subagentRunId: string }).subagentRunId;
    expect(tagsOf(stream).slice(1)).toEqual(Array(stream.length - 1).fill(id));
    await verifiedRun(stream);
  });

  it("closes the transfer source before opening the target and links the spawning call", async () => {
    const { stream } = run(translator(), [
      ...transfer("root", "a", "xfer-1"),
      text({ author: "a", text: "a spea", partial: true }),
      text({ author: "a", text: "a speaks" }),
      ...transfer("a", "b", "xfer-2"),
      text({ author: "b", text: "b speaks" }),
    ]);
    const started = stream.filter((e) => e.type === EventType.SUBAGENT_STARTED);
    expect(started[0]).toMatchObject({
      name: "a",
      parentToolCallId: "xfer-1",
      parentMessageId: "root:call:xfer-1",
    });
    expect(started[1]).toMatchObject({
      name: "b",
      parentToolCallId: "xfer-2",
      parentSubagentRunId: (started[0] as { subagentRunId: string })
        .subagentRunId,
    });
    const order = types(stream);
    expect(order.indexOf(EventType.SUBAGENT_FINISHED)).toBeLessThan(
      order.lastIndexOf(EventType.SUBAGENT_STARTED),
    );
    await verifiedRun(stream);
  });

  it("gives a re-invoked agent a fresh id instead of reusing a closed one", async () => {
    const { stream } = run(translator(), [
      text({ author: "a", text: "first" }),
      text({ author: "root", text: "back to root" }),
      text({ author: "a", text: "second" }),
    ]);
    const ids = stream
      .filter((e) => e.type === EventType.SUBAGENT_STARTED)
      .map((e) => (e as { subagentRunId: string }).subagentRunId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(lifecycle(stream)).toEqual([
      `SUBAGENT_STARTED:${ids[0]}`,
      `SUBAGENT_FINISHED:${ids[0]}`,
      `SUBAGENT_STARTED:${ids[1]}`,
      `SUBAGENT_FINISHED:${ids[1]}`,
    ]);
    await verifiedRun(stream);
  });

  it("does not close concurrent parallel siblings on interleaved partials", async () => {
    const { stream } = run(translator(), [
      text({ author: "x", branch: "pipeline.x", text: "x1", partial: true }),
      text({ author: "y", branch: "pipeline.y", text: "y1", partial: true }),
      text({ author: "x", branch: "pipeline.x", text: "x1x2" }),
      text({ author: "y", branch: "pipeline.y", text: "y1y2" }),
    ]);
    const finishedAt = types(stream).indexOf(EventType.SUBAGENT_FINISHED);
    const lastContentAt = types(stream).lastIndexOf(
      EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(finishedAt).toBeGreaterThan(lastContentAt);
    await verifiedRun(stream);
  });

  it("closes parallel children deepest-first when the parent branch resumes", async () => {
    const { stream } = run(translator(), [
      text({ author: "x", branch: "pipeline.x", text: "x" }),
      text({ author: "y", branch: "pipeline.y", text: "y" }),
      text({ author: "root", text: "joined" }),
    ]);
    const order = types(stream);
    const rootText = order.lastIndexOf(EventType.TEXT_MESSAGE_START);
    const finishes = order
      .map((type, index) => (type === EventType.SUBAGENT_FINISHED ? index : -1))
      .filter((index) => index >= 0);
    expect(finishes).toHaveLength(2);
    expect(Math.max(...finishes)).toBeLessThan(rootText);
    await verifiedRun(stream);
  });

  it("does not close on workflow output; the last output is the result", async () => {
    const { stream } = run(translator(), [
      text({ author: "a", path: "a", text: "draft", output: "draft" }),
      text({ author: "a", path: "a", text: "final", output: "final" }),
    ]);
    expect(lifecycle(stream)).toHaveLength(2);
    expect(stream.at(-1)).toMatchObject({
      type: EventType.SUBAGENT_FINISHED,
      result: "final",
      outcome: { type: "success" },
    });
    await verifiedRun(stream);
  });

  it("compares branches by segment, not by string prefix", async () => {
    const { stream } = run(translator(), [
      text({ author: "x", branch: "ab@1", text: "x" }),
      text({ author: "y", branch: "a", text: "y" }),
    ]);
    // "a" is not an ancestor of "ab@1", so x is still open when y starts.
    const order = lifecycle(stream);
    expect(order[0]).toMatch(/^SUBAGENT_STARTED:.*:x#1$/);
    expect(order[1]).toMatch(/^SUBAGENT_STARTED:.*:y#1$/);
    await verifiedRun(stream);
  });

  it("suspends the owner with its interrupt ids and its ancestors without ids", async () => {
    const t = translator();
    const { stream, interrupts, owners } = run(t, [
      text({ author: "a", path: "a", text: "delegating" }),
      requestInput("b", "ask-1", "a.b"),
    ]);
    const finished = stream.filter(
      (e) => e.type === EventType.SUBAGENT_FINISHED,
    );
    expect(finished[0]).toMatchObject({
      outcome: { type: "suspended", interruptIds: ["ask-1"] },
    });
    expect(finished[1]).toMatchObject({ outcome: { type: "suspended" } });
    expect(finished[1]).not.toHaveProperty("outcome.interruptIds");
    const owner = owners.get("ask-1");
    expect(owner).toMatchObject({
      name: "b",
      path: "a.b",
      parentSubagentRunId: (finished[1] as { subagentRunId: string })
        .subagentRunId,
    });
    expect(interrupts[0]).toMatchObject({
      subagentRunId: owner?.subagentRunId,
    });
    await verifiedRun(stream, interrupts);
  });

  it("re-announces a suspended invocation under its stored id on resume", async () => {
    const continuation: SubagentContinuation = {
      subagentRunId: "adk:previous-run:-:-:b#1",
      name: "b",
      parentToolCallId: "xfer-9",
    };
    const { stream } = run(
      translator({
        continuations: new Map([["ask-1", continuation]]),
        answeredInterruptIds: new Set(["ask-1"]),
      }),
      [text({ author: "b", text: "resumed" })],
    );
    expect(stream[0]).toMatchObject({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "adk:previous-run:-:-:b#1",
      parentToolCallId: "xfer-9",
    });
    expect(stream.at(-1)).toMatchObject({
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "adk:previous-run:-:-:b#1",
      outcome: { type: "success" },
    });
    await verifiedRun(stream);
  });

  it("announces an AgentTool by tool call and finishes it on the response", async () => {
    const helper = new LlmAgent({
      name: "helper",
      model: "m",
      description: "Helps",
    });
    const root = new LlmAgent({
      name: "root",
      model: "m",
      tools: [new AgentTool({ agent: helper })],
    });
    const t = translator({ tree: indexAgentTree(root) });
    const { stream } = run(t, [
      createEvent({
        id: "root:call",
        invocationId: "inv-1",
        author: "root",
        content: {
          role: "model",
          parts: [
            { functionCall: { id: "call-1", name: "helper", args: { q: 1 } } },
          ],
        },
      }),
      createEvent({
        id: "root:resp",
        invocationId: "inv-1",
        author: "root",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "helper",
                response: { answer: 42 },
              },
            },
          ],
        },
      }),
    ]);
    const order = types(stream);
    expect(order.indexOf(EventType.SUBAGENT_STARTED)).toBeGreaterThan(
      order.indexOf(EventType.TOOL_CALL_END),
    );
    expect(
      stream.find((e) => e.type === EventType.SUBAGENT_STARTED),
    ).toMatchObject({
      subagentRunId: "adk:inv-1:tool:call-1",
      name: "helper",
      description: "Helps",
      parentToolCallId: "call-1",
      parentMessageId: "root:call",
    });
    expect(order.indexOf(EventType.SUBAGENT_FINISHED)).toBeGreaterThan(
      order.indexOf(EventType.TOOL_CALL_RESULT),
    );
    expect(
      stream.find((e) => e.type === EventType.SUBAGENT_FINISHED),
    ).toMatchObject({
      result: { answer: 42 },
    });
    // Only the invocation's own lifecycle names it; the root's content,
    // tool call, and result are not tagged.
    const lifecycleTypes: string[] = [
      EventType.SUBAGENT_STARTED,
      EventType.SUBAGENT_FINISHED,
      EventType.STEP_STARTED,
      EventType.STEP_FINISHED,
    ];
    const contentTags = tagsOf(
      stream.filter((e) => !lifecycleTypes.includes(e.type)),
    );
    expect(contentTags.every((tag) => tag === undefined)).toBe(true);
    await verifiedRun(stream);
  });

  it("queues SUBAGENT_ERROR for a failed workflow node before the run errors", () => {
    const t = translator();
    const stream = [
      ...t.translate(
        text({ author: "a", path: "a", text: "work", partial: true }),
      ),
    ];
    expect(() =>
      t.translate(
        createNodeErrorEvent({
          error: new Error("boom"),
          author: "a",
          invocationId: "inv-1",
          nodeInfo: { path: "a" },
        }),
      ),
    ).toThrow(ADKJSProtocolError);
    const drained = t.drainErrorEvents();
    expect(types(drained)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.STEP_FINISHED,
      EventType.SUBAGENT_ERROR,
    ]);
    expect(drained.at(-1)).toMatchObject({ message: "boom" });
    expect(stream[0].type).toBe(EventType.SUBAGENT_STARTED);
  });

  it("does not end a still-streaming node when a concurrent same-branch node interleaves", async () => {
    // Concurrent workflow nodes may share a branch (no useSubBranch). Treating
    // the other node as a sequential sibling would close the first mid-stream,
    // duplicating its text into a second message once its aggregate arrives.
    const script = [
      text({
        id: "a:p",
        author: "a",
        path: "fan.a",
        text: "Hel",
        partial: true,
      }),
      text({
        id: "b:p",
        author: "b",
        path: "fan.b",
        text: "Wor",
        partial: true,
      }),
      text({ id: "a:p", author: "a", path: "fan.a", text: "Hello" }),
      text({ id: "b:p", author: "b", path: "fan.b", text: "World" }),
    ];
    const attributed = run(translator(), script);
    const starts = attributed.stream.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    );
    expect(starts.map((e) => e.messageId)).toEqual(["a:p", "b:p"]);
    const deltas = attributed.stream
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => `${e.messageId}:${e.delta}`);
    expect(deltas).toEqual(["a:p:Hel", "b:p:Wor", "a:p:lo", "b:p:ld"]);
    expect(
      lifecycle(attributed.stream).filter((l) =>
        l.startsWith("SUBAGENT_STARTED"),
      ),
    ).toHaveLength(2);
    await verifiedRun(attributed.stream);

    // The default mode must match a translator without subagent support here.
    const plain = run(new ADKEventTranslator({}), script);
    const off = run(translator({ mode: "off" }), script);
    expect(off.stream).toEqual(plain.stream);
  });

  it("does not end a streaming sub-agent when the root speaks in between", () => {
    const script = [
      text({ id: "a:p", author: "a", text: "Hel", partial: true }),
      text({ author: "root", text: "meanwhile" }),
      text({ id: "a:p", author: "a", text: "Hello" }),
    ];
    const plain = run(new ADKEventTranslator({}), script);
    const off = run(translator({ mode: "off" }), script);
    expect(off.stream).toEqual(plain.stream);
    expect(
      plain.stream.filter((e) => e.type === EventType.TEXT_MESSAGE_START),
    ).toHaveLength(2);
  });

  it("does not suspend an invocation for an interrupt the resume already answered", () => {
    // A resumed sub-agent may re-raise the same call id (some models reuse
    // ids); that id is settled by this run's resume payload, not pending.
    const t = translator({ answeredInterruptIds: new Set(["ask-1"]) });
    const { stream, owners } = run(t, [requestInput("b", "ask-1")]);
    expect(stream.at(-1)).toMatchObject({
      type: EventType.SUBAGENT_FINISHED,
      outcome: { type: "success" },
    });
    expect(owners.size).toBe(0);
  });

  it("names every fan-in sibling in the next handoff, and never a failed node", () => {
    const t = translator({ mode: "steps" });
    const { stream } = run(t, [
      text({ author: "x", branch: "pipeline.x", text: "x" }),
      text({ author: "y", branch: "pipeline.y", text: "y" }),
      text({ author: "a", text: "joined" }),
    ]);
    const handoffs = stream
      .filter((e) => e.type === EventType.CUSTOM)
      .map((e) => e.value);
    expect(handoffs).toEqual([{ from_nodes: ["x", "y"], to_nodes: ["a"] }]);

    const failing = translator({ mode: "steps" });
    const events = [
      ...failing.translate(
        text({ author: "x", branch: "pipeline.x", text: "x" }),
      ),
    ];
    expect(() =>
      failing.translate(
        createNodeErrorEvent({
          error: new Error("boom"),
          author: "x",
          branch: "pipeline.x",
          invocationId: "inv-1",
          nodeInfo: { path: "x" },
        }),
      ),
    ).toThrow(ADKJSProtocolError);
    events.push(
      ...failing.drainErrorEvents(),
      ...failing.translate(
        text({ author: "y", branch: "pipeline.y", text: "y" }),
      ),
    );
    expect(events.filter((e) => e.type === EventType.CUSTOM)).toEqual([]);
  });

  it("emits the dojo pipeline step and handoff contract without any subagent surface", async () => {
    const { stream } = run(translator({ mode: "steps" }), [
      text({ author: "x", path: "x", text: "Research: facts" }),
      text({ author: "y", path: "y", text: "Analysis: implications" }),
    ]);
    expect(
      stream.map((event) =>
        event.type === EventType.CUSTOM
          ? `${event.type}:${event.name}:${JSON.stringify(event.value)}`
          : event.type === EventType.STEP_STARTED ||
              event.type === EventType.STEP_FINISHED
            ? `${event.type}:${event.stepName}`
            : event.type,
      ),
    ).toEqual([
      "STEP_STARTED:agent:x",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "STEP_FINISHED:agent:x",
      "STEP_STARTED:agent:y",
      'CUSTOM:MultiAgentHandoff:{"from_nodes":["x"],"to_nodes":["y"]}',
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "STEP_FINISHED:agent:y",
    ]);
    expect(JSON.stringify(stream)).not.toContain("subagentRunId");
    await verifiedRun(stream);
  });

  it("leaves nothing active at RUN_FINISHED in every subagent mode", async () => {
    for (const mode of ["off", "steps", "attributed"] as const) {
      const { stream, interrupts } = run(translator({ mode }), [
        text({ author: "x", branch: "pipeline.x", text: "x", partial: true }),
        text({ author: "y", branch: "pipeline.y", text: "y", partial: true }),
        ...transfer("root", "a", "xfer-1"),
        text({ author: "a", path: "a", text: "a" }),
        requestInput("b", "ask-1", "a.b"),
      ]);
      await verifiedRun(
        stream,
        mode === "attributed"
          ? interrupts
          : interrupts.map(({ subagentRunId: _tag, ...rest }) => rest),
      );
    }
  });
});
