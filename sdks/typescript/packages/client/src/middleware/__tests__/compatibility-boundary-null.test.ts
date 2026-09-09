import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { from, lastValueFrom, type Observable } from "rxjs";
import { tap, toArray } from "rxjs/operators";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { EventSchema, RunAgentInputSchema } from "@ag-ui/core/schemas";
import { decode } from "@ag-ui/proto";
import { AbstractAgent, HttpAgent } from "@/agent";
import * as clientApi from "@/index";
import * as middlewareApi from "@/middleware";
import { normalizeLegacyRunAgentInput } from "../compatibility-boundary";

it("keeps legacy request normalization out of the public API", () => {
  expect(clientApi).not.toHaveProperty("normalizeLegacyRunAgentInput");
  expect(middlewareApi).not.toHaveProperty("normalizeLegacyRunAgentInput");
});

const ids = { threadId: "t", runId: "r" };
const start = { type: EventType.RUN_STARTED, ...ids };
const finish = { type: EventType.RUN_FINISHED, ...ids };
const input = { ...ids, messages: [], tools: [], context: [] };
const inputEvent = (fields: object) => ({ ...start, input: { ...input, ...fields } });
const snapshot = (metadata: object, type: "image" | "audio" | "video" | "document") => ({
  type: EventType.MESSAGES_SNAPSHOT,
  messages: [
    {
      id: "m",
      role: "user",
      content: [
        {
          type,
          source: { type: "url", value: "https://example.test/media" },
          ...metadata,
        },
      ],
    },
  ],
});

class MemoryAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super({ threadId: ids.threadId });
  }
  override run(): Observable<BaseEvent> {
    return from(this.events);
  }
  protected override connect(): Observable<BaseEvent> {
    return from(this.events);
  }
}

async function collect(path: "run" | "connect" | "sse", events: BaseEvent[]) {
  const agent =
    path === "sse"
      ? new HttpAgent({
          threadId: ids.threadId,
          url: "https://example.test/agent",
          // Literal old-peer JSON: the current EventEncoder would omit these nulls
          // before the client receives them, concealing an incoming regression.
          fetch: async () =>
            new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
              headers: { "Content-Type": "text/event-stream" },
            }),
        })
      : new MemoryAgent(events);
  const seen: BaseEvent[] = [];
  const middlewareSeen: BaseEvent[] = [];
  agent.use((runInput: RunAgentInput, next: AbstractAgent) =>
    next.run(runInput).pipe(tap((event) => middlewareSeen.push(event))),
  );
  agent.subscribe({
    onEvent: ({ event }) => {
      seen.push(event);
    },
  });
  if (path === "connect") await agent.connectAgent({ runId: ids.runId });
  else await agent.runAgent({ runId: ids.runId });
  return { seen, middlewareSeen };
}

beforeEach(() => {
  vi.stubEnv("SUPPRESS_TRANSFORMATION_WARNINGS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const cases = [
  {
    name: "BaseEvent.rawEvent",
    events: [start, { type: EventType.CUSTOM, name: "x", value: null, rawEvent: null }, finish],
    expected: [start, { type: EventType.CUSTOM, name: "x", value: null }, finish],
  },
  {
    name: "RUN_FINISHED.result (together with rawEvent and legacy outcome)",
    events: [start, { ...finish, result: null, rawEvent: null, outcome: null }],
    expected: [start, finish],
  },
  {
    name: "SUBAGENT_FINISHED.result",
    events: [
      start,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s", name: "child" },
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s", result: null },
      finish,
    ],
    expected: [
      start,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s", name: "child" },
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s" },
      finish,
    ],
  },
  {
    name: "RunAgentInput.forwardedProps",
    events: [inputEvent({ forwardedProps: null }), finish],
    expected: [inputEvent({}), finish],
  },
  {
    name: "Tool.parameters",
    events: [
      inputEvent({ tools: [{ name: "tool", description: "description", parameters: null }] }),
      finish,
    ],
    expected: [inputEvent({ tools: [{ name: "tool", description: "description" }] }), finish],
  },
  {
    name: "ResumeEntry.payload",
    events: [
      inputEvent({ resume: [{ interruptId: "i", status: "resolved", payload: null }] }),
      finish,
    ],
    expected: [inputEvent({ resume: [{ interruptId: "i", status: "resolved" }] }), finish],
  },
  ...(["image", "audio", "video", "document"] as const).map((type) => ({
    name: `${type}InputContent.metadata`,
    events: [start, snapshot({ metadata: null }, type), finish],
    expected: [start, snapshot({}, type), finish],
  })),
  {
    name: "media metadata inside RUN_STARTED.input",
    events: [inputEvent({ messages: snapshot({ metadata: null }, "image").messages }), finish],
    expected: [inputEvent({ messages: snapshot({}, "image").messages }), finish],
  },
];

describe.each(["run", "connect", "sse"] as const)("legacy optional nulls through %s", (path) => {
  it.each(cases)(
    "accepts $name, omits the field and finishes the run",
    async ({ events, expected }) => {
      const original = structuredClone(events);
      const { seen, middlewareSeen } = await collect(path, events);
      expect(seen).toEqual(expected);
      expect(seen.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      for (const event of seen) expect(EventSchema.safeParse(event).success).toBe(true);
      if (path !== "connect") expect(middlewareSeen).toEqual(expected);
      expect(events).toEqual(original);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("null"));
    },
  );

  it("preserves required nulls and nulls within application data", async () => {
    const data = { rawEvent: null, result: null, metadata: null, forwardedProps: null };
    const events = [
      inputEvent({
        state: data,
        forwardedProps: data,
        tools: [{ name: "tool", description: "d", parameters: data }],
        resume: [{ interruptId: "i", status: "resolved", payload: data }],
      }),
      { type: EventType.RAW, event: null },
      { type: EventType.CUSTOM, name: "x", value: null, rawEvent: data, metadata: data },
      { type: EventType.STATE_SNAPSHOT, snapshot: { x: "before" } },
      { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/x", value: null }] },
      { type: EventType.STATE_SNAPSHOT, snapshot: null },
      snapshot({ metadata: data }, "image"),
      { ...finish, result: data },
    ];
    expect((await collect(path, events)).seen).toEqual(events);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("the internal request compatibility helper", () => {
  it("normalizes every legacy request position without changing application data or the caller's object", () => {
    const data = { metadata: null, payload: null, forwardedProps: null };
    const messages = (["image", "audio", "video", "document"] as const).map((type) => ({
      ...snapshot({ metadata: null }, type).messages[0],
      id: type,
    }));
    const legacy = {
      ...input,
      state: null,
      forwardedProps: null,
      messages,
      tools: [
        { name: "tool", description: "d", parameters: null },
        { name: "opaque", description: "d", parameters: data },
      ],
      resume: [{ interruptId: "i", status: "resolved", payload: null, metadata: data }],
    };
    const original = structuredClone(legacy);
    expect(RunAgentInputSchema.safeParse(legacy).success).toBe(false);
    const normalized = normalizeLegacyRunAgentInput(legacy);
    expect(normalized).toEqual({
      ...input,
      state: null,
      messages: (["image", "audio", "video", "document"] as const).map((type) => ({
        ...snapshot({}, type).messages[0],
        id: type,
      })),
      tools: [
        { name: "tool", description: "d" },
        { name: "opaque", description: "d", parameters: data },
      ],
      resume: [{ interruptId: "i", status: "resolved", metadata: data }],
    });
    expect(RunAgentInputSchema.parse(normalized)).toMatchObject({ state: undefined });
    expect(legacy).toEqual(original);
    expect(normalizeLegacyRunAgentInput(normalized)).toBe(normalized);
  });

  it.each([
    null,
    42,
    [],
    { ...input, tools: null },
    { ...input, messages: [null] },
    { ...input, parentRunId: null },
    { ...input, tools: [{ name: "tool", description: null }] },
    { ...input, messages: [{ id: "m", role: "user", content: null }] },
    { ...input, messages: [{ id: "m", role: "user", content: "hello", metadata: null }] },
  ])("leaves malformed requests invalid: %j", (value) => {
    expect(RunAgentInputSchema.safeParse(normalizeLegacyRunAgentInput(value)).success).toBe(false);
  });
});

describe("existing null restrictions", () => {
  it.each([
    { field: "metadata", event: { ...finish, metadata: null } },
    { field: "parentRunId", event: { ...start, parentRunId: null } },
    { field: "timestamp", event: { ...finish, timestamp: null } },
    { field: "parentRunId", event: inputEvent({ parentRunId: null }) },
    {
      field: "content",
      event: inputEvent({ messages: [{ id: "m", role: "user", content: null }] }),
    },
  ])("keeps the pre-existing $field:null restriction", async ({ field, event }) => {
    // The BaseEvent index signature admits old/invalid wire shapes, but named
    // fields such as metadata are intentionally stricter. Literal SSE is the
    // untyped wire boundary used for these malformed fixtures.
    const agent = new HttpAgent({
      threadId: ids.threadId,
      url: "https://example.test/agent",
      fetch: async () =>
        new Response(
          [start, event, finish].map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    await expect(agent.runAgent({ runId: ids.runId })).rejects.toThrow(field);
  });
});

it("accepts protobuf bytes emitted by main with rawEvent:null and result:null", async () => {
  // EventEncoder on main 7c3bd253: RUN_STARTED followed by RUN_FINISHED with
  // rawEvent:null/result:null. Keep literal bytes: the new encoder omits them.
  const opener = Buffer.from("0000000c620a0a02080b1201741a0172", "hex");
  const terminal = Buffer.from("000000146a120a06080c1a0208001201741a017222020800", "hex");
  expect(decode(terminal.subarray(4))).toMatchObject({ rawEvent: null, result: null });
  const agent = new HttpAgent({
    threadId: ids.threadId,
    url: "https://example.test/agent",
    fetch: async () =>
      new Response(Buffer.concat([opener, terminal]), {
        headers: { "Content-Type": "application/vnd.ag-ui.event+proto" },
      }),
  });
  const seen: BaseEvent[] = [];
  await agent.runAgent(
    { runId: ids.runId },
    {
      onEvent: ({ event }) => {
        seen.push(event);
      },
    },
  );
  expect(seen).toEqual([start, finish]);
  for (const event of seen) expect(EventSchema.safeParse(event).success).toBe(true);
});

it("normalizes incoming nulls before the legacy CopilotKit bridge", async () => {
  const agent = new MemoryAgent([start, { ...finish, rawEvent: null, result: null }]);
  const seen: BaseEvent[] = [];
  agent.use((runInput, next) => next.run(runInput).pipe(tap((event) => seen.push(event))));
  await lastValueFrom(
    agent.legacy_to_be_removed_runAgentBridged({ runId: ids.runId }).pipe(toArray()),
  );
  expect(seen).toEqual([start, finish]);
});
