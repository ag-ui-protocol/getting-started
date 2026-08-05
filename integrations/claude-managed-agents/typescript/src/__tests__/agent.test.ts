import { EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { ManagedAgentsAgent } from "../agent";
import { InMemorySessionStore } from "../sessions";
import type { BackendCustomTool, ManagedAgentsAgentConfig, SessionStore } from "../types";
import { createFakeClient } from "./fake-client";
import { RecordingSessionStore } from "./fake-store";

const idleEndTurn = { type: "session.status_idle", id: "idle_1", stop_reason: { type: "end_turn" } };

/**
 * The key the store and the busy gate share: scoped to the managed agent, not
 * the bare (client-supplied) thread id.
 */
const SESSION_KEY = "7:agent_1|0:|5:env_1|0:|thread_1";

const baseInput = (overrides: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: "thread_1",
  runId: "run_1",
  state: {},
  messages: [{ id: "u1", role: "user", content: "Hello" }],
  tools: [],
  context: [],
  forwardedProps: {},
  ...overrides,
});

const collect = async (agent: ManagedAgentsAgent, input: RunAgentInput): Promise<BaseEvent[]> =>
  (await lastValueFrom(agent.run(input).pipe(toArray()))) as BaseEvent[];

const types = (events: BaseEvent[]) => events.map((event) => event.type);

const newAgent = (
  fake: ReturnType<typeof createFakeClient>,
  store: SessionStore = new InMemorySessionStore(),
  extra: Partial<ManagedAgentsAgentConfig> = {},
) =>
  new ManagedAgentsAgent({
    managedAgentId: "agent_1",
    environmentId: "env_1",
    client: fake.client,
    sessionStore: store,
    ...extra,
  });

/** A deferred promise, used as a gate to hold a stream (and its run) open. */
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

const allSentEvents = (fake: ReturnType<typeof createFakeClient>) => fake.sent.flatMap((send) => send.events);

/** Let a run in flight advance a few microtask/macrotask turns. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("ManagedAgentsAgent", () => {
  it("creates a session for a new thread and streams a reply", async () => {
    const fake = createFakeClient({
      streams: [[{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Hi!" }] }, idleEndTurn]],
    });
    const events = await collect(newAgent(fake), baseInput());

    expect(fake.spies.create.mock.calls[0]![0]).toEqual({
      agent: { type: "agent", id: "agent_1" },
      environment_id: "env_1",
      title: "AG-UI thread thread_1",
    });
    expect(types(events)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events[2]).toMatchObject({ name: "managed_agents.session", value: { sessionId: "sesn_1", threadId: "thread_1" } });
    expect(fake.sent[0].events).toEqual([{ type: "user.message", content: [{ type: "text", text: "Hello" }] }]);
  });

  it("pins the agent version and applies a custom title when configured", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    await collect(newAgent(fake, undefined, { agentVersion: 3, sessionTitle: (id) => `Chat ${id}` }), baseInput());

    expect(fake.spies.create.mock.calls[0]![0]).toEqual({
      agent: { type: "agent", id: "agent_1", version: 3 },
      environment_id: "env_1",
      title: "Chat thread_1",
    });
    expect(fake.spies.retrieve).not.toHaveBeenCalled();
  });

  it("attaches configured vault ids when creating a session", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn], [idleEndTurn]] });
    await collect(newAgent(fake, undefined, { vaultIds: ["vlt_1", "vlt_2"] }), baseInput());
    expect(fake.spies.create.mock.calls[0]![0]).toMatchObject({ vault_ids: ["vlt_1", "vlt_2"] });

    // Omitted entirely when none are configured, so the field is not sent empty.
    await collect(newAgent(fake), baseInput());
    expect(fake.spies.create.mock.calls[1]![0]).not.toHaveProperty("vault_ids");
  });

  it("reuses the session on the thread's next run and sends only the new message", async () => {
    const fake = createFakeClient({
      streams: [
        [{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "one" }] }, idleEndTurn],
        [{ type: "agent.message", id: "msg_2", content: [{ type: "text", text: "two" }] }, idleEndTurn],
      ],
    });
    const store = new InMemorySessionStore();
    await collect(newAgent(fake, store), baseInput());
    await collect(
      newAgent(fake, store),
      baseInput({
        runId: "run_2",
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "a1", role: "assistant", content: "one" },
          { id: "u2", role: "user", content: "Follow-up" },
        ],
      }),
    );

    expect(fake.spies.create).toHaveBeenCalledTimes(1);
    expect(fake.sent[1].events).toEqual([{ type: "user.message", content: [{ type: "text", text: "Follow-up" }] }]);
  });

  it("registers frontend tools as custom tools when creating the session", async () => {
    const fake = createFakeClient({
      streams: [[idleEndTurn]],
      agentTools: [{ type: "agent_toolset_20260401", configs: [], default_config: {} }],
    });
    await collect(
      newAgent(fake),
      baseInput({
        tools: [{ name: "show_chart", description: "Render a chart", parameters: { type: "object", properties: { title: { type: "string" } } } }],
      }),
    );

    expect(fake.spies.create.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        agent: {
          type: "agent_with_overrides",
          id: "agent_1",
          tools: [
            { type: "agent_toolset_20260401", configs: [], default_config: {} },
            {
              type: "custom",
              name: "show_chart",
              description: "Render a chart",
              input_schema: { type: "object", properties: { title: { type: "string" } } },
            },
          ],
        },
      }),
    );
  });

  it("registers backend and frontend tools by normalized name with the frontend winning a collision", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]], agentTools: [] });
    const backend: BackendCustomTool = { name: "lookup docs", description: "Backend lookup", parameters: {}, handler: () => "x" };
    await collect(
      newAgent(fake, undefined, { backendTools: [backend] }),
      baseInput({ tools: [{ name: "lookup docs", description: "Frontend lookup", parameters: { type: "object" } }] }),
    );

    expect(fake.spies.create.mock.calls[0]![0].agent.tools).toEqual([
      { type: "custom", name: "lookup_docs", description: "Frontend lookup", input_schema: { type: "object" } },
    ]);
  });

  it("keeps the last definition when two frontend tool names collide after normalization", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]], agentTools: [] });
    const events = await collect(
      newAgent(fake),
      baseInput({
        tools: [
          { name: "search web", description: "first", parameters: { type: "object" } },
          { name: "search.web", description: "second", parameters: { type: "object" } },
        ],
      }),
    );

    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(fake.spies.create.mock.calls[0]![0].agent.tools).toEqual([
      { type: "custom", name: "search_web", description: "second", input_schema: { type: "object" } },
    ]);
  });

  it("dedupes registered tools against the agent's own custom tools", async () => {
    const fake = createFakeClient({
      streams: [[idleEndTurn]],
      agentTools: [
        { type: "agent_toolset_20260401", configs: [], default_config: {} },
        { type: "custom", name: "show_chart", description: "Agent's own copy", input_schema: { type: "object", properties: {} } },
      ],
    });
    await collect(
      newAgent(fake),
      baseInput({ tools: [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }] }),
    );

    // The frontend tool replaces the agent's same-named custom tool rather than duplicating it.
    expect(fake.spies.create.mock.calls[0]![0].agent.tools).toEqual([
      { type: "agent_toolset_20260401", configs: [], default_config: {} },
      { type: "custom", name: "show_chart", description: "Render a chart", input_schema: { type: "object" } },
    ]);
  });

  it("round-trips a frontend tool: park, then resume with the client's result", async () => {
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: { title: "Sales" } },
          { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } },
        ],
        [{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Chart shown." }] }, idleEndTurn],
      ],
    });
    const store = new InMemorySessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    const first = await collect(newAgent(fake, store), baseInput({ tools }));
    expect(types(first)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.CUSTOM,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ]);
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: ["ctu_1"] });

    const second = await collect(
      newAgent(fake, store),
      baseInput({
        runId: "run_2",
        tools,
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "t1", role: "tool", toolCallId: "ctu_1", content: "rendered" },
        ],
      }),
    );

    expect(fake.sent[1].events).toEqual([
      { type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "rendered" }], is_error: false },
    ]);
    expect(types(second)).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(second.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: [] });
  });

  it("forwards a tool message's error flag and error text", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new InMemorySessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: ["ctu_1"], lastUserMessageId: "u1" });

    await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "t1", role: "tool", toolCallId: "ctu_1", content: "boom", error: "failed" },
        ],
      }),
    );

    expect(fake.sent[0].events).toEqual([
      { type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "boom\nfailed" }], is_error: true },
    ]);
  });

  it("stays parked when only some pending tool calls are answered", async () => {
    const fake = createFakeClient({ streams: [] });
    const store = new InMemorySessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: ["ctu_1", "ctu_2"], lastUserMessageId: "u1" });

    const events = await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "t1", role: "tool", toolCallId: "ctu_1", content: "done" },
        ],
      }),
    );

    // The answered call is posted, the run finishes without streaming, and
    // the unanswered call stays pending.
    expect(fake.sent[0].events).toEqual([
      { type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "done" }], is_error: false },
    ]);
    expect(fake.spies.stream).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: ["ctu_2"] });
  });

  it("clone() carries the AbstractAgent state and keeps the client and store shared", () => {
    // Regression: clone() constructed a fresh ManagedAgentsAgent, so the thread
    // ID, messages, state, subscribers and middleware of the original were all
    // silently reset on the copy.
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new InMemorySessionStore();
    const agent = newAgent(fake, store, { agentId: "agent_ui", description: "Managed" });
    agent.threadId = "thread_carried";
    agent.messages = [{ id: "m1", role: "user", content: "carried" }];
    agent.state = { count: 1 };
    agent.subscribe({ onEvent: () => {} });

    const cloned = agent.clone();

    expect(cloned).toBeInstanceOf(ManagedAgentsAgent);
    expect(cloned).not.toBe(agent);
    expect(cloned.agentId).toBe("agent_ui");
    expect(cloned.description).toBe("Managed");
    expect(cloned.threadId).toBe("thread_carried");
    expect(cloned.messages).toEqual(agent.messages);
    expect(cloned.state).toEqual({ count: 1 });
    expect(cloned.subscribers).toHaveLength(agent.subscribers.length);
    // Copied, not aliased: mutating the clone must not touch the original.
    cloned.messages.push({ id: "m2", role: "user", content: "only mine" });
    expect(agent.messages).toHaveLength(1);
    // The client and store stay shared so the clone resumes the same sessions.
    const fields = (instance: ManagedAgentsAgent) => instance as unknown as { client: unknown; store: unknown };
    expect(fields(cloned).client).toBe(fields(agent).client);
    expect(fields(cloned).store).toBe(fields(agent).store);
    // And a clone of a clone keeps them.
    expect(fields(cloned.clone()).store).toBe(fields(agent).store);
  });

  it("shares the session store across clones so a resumed run finds its parked session", async () => {
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } },
        ],
        [{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Done." }] }, idleEndTurn],
      ],
    });
    // No sessionStore passed: the default in-memory store must be shared by clones.
    const parent = new ManagedAgentsAgent({ managedAgentId: "agent_1", environmentId: "env_1", client: fake.client });
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    await collect(parent.clone(), baseInput({ tools }));
    await collect(
      parent.clone(),
      baseInput({
        runId: "run_2",
        tools,
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "t1", role: "tool", toolCallId: "ctu_1", content: "rendered" },
        ],
      }),
    );

    expect(fake.spies.create).toHaveBeenCalledTimes(1);
    expect(fake.sent[1].events).toEqual([
      { type: "user.custom_tool_result", custom_tool_use_id: "ctu_1", content: [{ type: "text", text: "rendered" }], is_error: false },
    ]);
  });

  it("forwards every undelivered user message in order", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new InMemorySessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: [], lastUserMessageId: "u1" });

    await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "delivered" },
          { id: "u2", role: "user", content: "second" },
          { id: "u3", role: "user", content: "third" },
        ],
      }),
    );

    expect(fake.sent[0].events).toEqual([
      { type: "user.message", content: [{ type: "text", text: "second" }] },
      { type: "user.message", content: [{ type: "text", text: "third" }] },
    ]);
    expect(await store.get(SESSION_KEY)).toMatchObject({ lastUserMessageId: "u3" });
  });

  it("extracts the text of multimodal user content", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    await collect(
      newAgent(fake),
      baseInput({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "Look here" }] as never }] }),
    );

    expect(fake.sent[0].events).toEqual([{ type: "user.message", content: [{ type: "text", text: "Look here" }] }]);
  });

  it("errors with empty_run for an image-only user message and creates no session", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const events = await collect(
      newAgent(fake),
      baseInput({
        messages: [{ id: "u1", role: "user", content: [{ type: "image", source: { type: "url", value: "https://x/y.png" } }] as never }],
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "empty_run" });
    expect(fake.spies.create).not.toHaveBeenCalled();
  });

  it("abandons parked tool calls when the user sends a new message instead", async () => {
    const fake = createFakeClient({
      streams: [[{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "Moving on." }] }, idleEndTurn]],
    });
    const store = new InMemorySessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: ["ctu_1"], lastUserMessageId: "u1" });

    const events = await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "old" },
          { id: "u2", role: "user", content: "never mind" },
        ],
      }),
    );

    // Tool results go first (resuming the parked session), then the message,
    // as two separate sends: the API rejects a user.message in the same batch
    // as the results while the session is still parked.
    expect(fake.sent[0].events).toEqual([
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "ctu_1",
        content: [{ type: "text", text: "The user did not provide a result for this tool call." }],
        is_error: true,
      },
    ]);
    expect(fake.sent[1].events).toEqual([{ type: "user.message", content: [{ type: "text", text: "never mind" }] }]);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: [], lastUserMessageId: "u2" });
  });

  it("keeps a parked tool id when a later session event fails the turn", async () => {
    // Regression: the session has already parked on ctu_1 by the time the
    // error arrives. Without the id the next run cannot answer that call, so
    // the remote session stays parked forever.
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          { type: "session.error", id: "err_1", error: { type: "overloaded_error", message: "upstream is busy", retry_status: { type: "exhausted" } } },
        ],
      ],
    });
    const store = new RecordingSessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    const events = await collect(newAgent(fake, store), baseInput({ tools }));

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "overloaded_error" });
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: ["ctu_1"] });
  });

  it("keeps a parked tool id when the stream throws after the park", async () => {
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          new Error("connection reset"),
        ],
      ],
    });
    const store = new RecordingSessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    const events = await collect(newAgent(fake, store), baseInput({ tools }));

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "run_failed" });
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: ["ctu_1"] });
  });

  it("forgets a parked call once the turn's interrupt has landed", async () => {
    // Regression: the park is persisted the moment the call is handed over, then
    // the turn interrupts the session and fails. The interrupt cancels the wait,
    // so answering that id on the next run is rejected as stale and wedges the
    // thread — it must not survive.
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          // Blocked on something this integration cannot answer: interrupt + fail.
          { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1", "mystery_1"] } },
        ],
      ],
    });
    const store = new RecordingSessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    const events = await collect(newAgent(fake, store), baseInput({ tools }));

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "unsupported_action" });
    expect(allSentEvents(fake)).toContainEqual({ type: "user.interrupt" });
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: [] });
  });

  it("keeps a parked call when the turn's interrupt could not be delivered", async () => {
    // The mirror image: nothing reached the session, so it may still be parked
    // and the id is still the only way to answer it.
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1", "mystery_1"] } },
        ],
      ],
      // Send 1 is the user message; send 2 is the interrupt.
      sendResults: [undefined, new Error("interrupt rejected")],
    });
    const store = new RecordingSessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    const events = await collect(newAgent(fake, store), baseInput({ tools }));

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "unsupported_action" });
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: ["ctu_1"] });
  });

  it("forgets a parked call once the teardown interrupt has landed", async () => {
    // A thrown turn never reaches recordOutcome, so the teardown path has to
    // reconcile the record itself.
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          new Promise<void>(() => {}), // hang until the turn times out
        ],
      ],
    });
    const store = new RecordingSessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    const events = await collect(newAgent(fake, store, { turnTimeoutMs: 30 }), baseInput({ tools }));

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "turn_timeout" });
    expect(allSentEvents(fake)).toContainEqual({ type: "user.interrupt" });
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: [] });
  });

  it("keeps a parked call when the teardown interrupt could not be delivered", async () => {
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          new Promise<void>(() => {}),
        ],
      ],
      sendResults: [undefined, new Error("interrupt rejected")],
    });
    const store = new RecordingSessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    const events = await collect(newAgent(fake, store, { turnTimeoutMs: 30 }), baseInput({ tools }));

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "turn_timeout" });
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: ["ctu_1"] });
  });

  it("clears a stale parked id when the session goes idle on end_turn", async () => {
    // Defensive: end_turn means nothing is awaited, so no pending id may
    // survive into the next run and be answered against a resumed session.
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new RecordingSessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: ["ctu_stale"], lastUserMessageId: "u1" });

    await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "u2", role: "user", content: "never mind" },
        ],
      }),
    );

    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: [] });
  });

  it("emits one terminal event when the store rejects the closing write after a run error", async () => {
    // Regression: the turn already emitted RUN_ERROR, then persisting the
    // outcome failed and the outer catch appended a second terminal event.
    const fake = createFakeClient({ streams: [[{ type: "session.status_terminated", id: "term_1" }]] });
    const store = new RecordingSessionStore();
    const failing = Object.assign(Object.create(Object.getPrototypeOf(store)) as RecordingSessionStore, store, {
      delete: async () => {
        throw new Error("store is down");
      },
    });
    const errors: { operation: string }[] = [];

    const events = await collect(
      newAgent(fake, failing, { onError: (_error, context) => void errors.push(context) }),
      baseInput(),
    );

    expect(types(events).filter((type) => type === EventType.RUN_ERROR || type === EventType.RUN_FINISHED)).toEqual([
      EventType.RUN_ERROR,
    ]);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "session_ended" });
    // The dropped error is not lost: it reaches the hook.
    expect(errors.map((context) => context.operation)).toContain("dropped_terminal_event");
  });

  // Guard rather than regression: this path already emitted one terminal event,
  // and must keep doing so now that the gate decides.
  it("emits one terminal event when the store rejects the closing write after a park", async () => {
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "show_chart", input: {} },
          { type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } },
        ],
      ],
    });
    const store = new RecordingSessionStore();
    let writes = 0;
    const failing: SessionStore = {
      get: (key) => store.get(key),
      set: async (key, record) => {
        // Let the park write through; fail the closing outcome write.
        if (++writes > 2) throw new Error("store is down");
        await store.set(key, record);
      },
      delete: (key) => store.delete(key),
    };

    const events = await collect(
      newAgent(fake, failing),
      baseInput({ tools: [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }] }),
    );

    expect(types(events).filter((type) => type === EventType.RUN_ERROR || type === EventType.RUN_FINISHED)).toEqual([
      EventType.RUN_ERROR,
    ]);
  });

  it("clears pending tool ids even when the follow-up send then fails", async () => {
    // Regression: once the tool results resume the session they are recorded
    // as delivered, even if the follow-up messages then fail. Re-posting a
    // consumed result on the next run would be rejected by the API and leave
    // the thread wedged. Asserted against an out-of-process-shaped store so
    // only genuinely persisted state counts.
    const fake = createFakeClient({
      streams: [[idleEndTurn]],
      // Send 0 (the tool results) succeeds; send 1 (the follow-up) fails.
      sendResults: [undefined, new Error("server exploded")],
    });
    const store = new RecordingSessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: ["ctu_1"], lastUserMessageId: "u1" });

    const events = await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "t1", role: "tool", toolCallId: "ctu_1", content: "done" },
          { id: "u2", role: "user", content: "and one more thing" },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: "The run failed.", code: "run_failed" });
    // The results were persisted as delivered; the follow-up never landed, so
    // the user message stays undelivered and is retried next run.
    expect(await store.get(SESSION_KEY)).toMatchObject({ pendingClientToolUseIds: [], lastUserMessageId: "u1" });
    expect(store.writes.at(-1)?.record).toMatchObject({ pendingClientToolUseIds: [], lastUserMessageId: "u1" });
  });

  it("records the follow-up delivery separately from the tool results", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new RecordingSessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: ["ctu_1"], lastUserMessageId: "u1" });
    store.writes.length = 0;

    await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "t1", role: "tool", toolCallId: "ctu_1", content: "done" },
          { id: "u2", role: "user", content: "and one more thing" },
        ],
      }),
    );

    // Two persists: one per delivery, in send order.
    expect(store.writes.map((write) => write.record)).toMatchObject([
      { pendingClientToolUseIds: [], lastUserMessageId: "u1" },
      { pendingClientToolUseIds: [], lastUserMessageId: "u2" },
    ]);
  });

  it("abandons multiple parked tool calls in their original order", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new InMemorySessionStore();
    await store.set(SESSION_KEY, {
      sessionId: "sesn_1",
      toolNames: [],
      pendingClientToolUseIds: ["ctu_1", "ctu_2", "ctu_3"],
      lastUserMessageId: "u1",
    });

    await collect(
      newAgent(fake, store),
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "old" },
          { id: "u2", role: "user", content: "never mind" },
        ],
      }),
    );

    expect(fake.sent[0].events.map((event) => (event as { custom_tool_use_id: string }).custom_tool_use_id)).toEqual([
      "ctu_1",
      "ctu_2",
      "ctu_3",
    ]);
    expect(fake.sent[0].events).toEqual(
      ["ctu_1", "ctu_2", "ctu_3"].map((id) => ({
        type: "user.custom_tool_result",
        custom_tool_use_id: id,
        content: [{ type: "text", text: "The user did not provide a result for this tool call." }],
        is_error: true,
      })),
    );
    expect(fake.sent[1].events).toEqual([{ type: "user.message", content: [{ type: "text", text: "never mind" }] }]);
  });

  it("keys the session store by managed agent and thread id", async () => {
    const fake = createFakeClient({
      streams: [[{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "a" }] }, idleEndTurn]],
    });
    const store = new RecordingSessionStore();

    await collect(newAgent(fake, store), baseInput());

    expect(fake.spies.create).toHaveBeenCalledTimes(1);
    expect(store.keys()).toEqual([SESSION_KEY]);
    // Never the bare, client-supplied thread id.
    expect(await store.get("thread_1")).toBeUndefined();
  });

  it("does not let agents differing only in environment share a session", async () => {
    // environmentId, agentVersion and vaultIds are baked into the remote session
    // at creation and can never be checked or changed on resume, so a key scoped
    // only by managed agent let a staging and a production agent on one store
    // share a session: every prod turn would then execute in staging, against
    // staging vaults, with nothing surfaced to say so.
    const staging = createFakeClient({ streams: [[idleEndTurn]], sessionId: "sesn_staging" });
    const prod = createFakeClient({ streams: [[idleEndTurn]], sessionId: "sesn_prod" });
    const store = new RecordingSessionStore();

    await collect(newAgent(staging, store, { environmentId: "env_staging" }), baseInput());
    await collect(newAgent(prod, store, { environmentId: "env_prod" }), baseInput({ runId: "run_2" }));

    expect(staging.spies.create).toHaveBeenCalledTimes(1);
    expect(prod.spies.create).toHaveBeenCalledTimes(1);
    expect(store.keys().sort()).toEqual(["7:agent_1|0:|8:env_prod|0:|thread_1", "7:agent_1|0:|11:env_staging|0:|thread_1"].sort());
  });

  it("does not let two agents sharing a store adopt each other's session", async () => {
    // Regression: the busy gate was scoped by managed agent while the store was
    // keyed by the bare thread id, so a second agent on the same thread id read
    // the first agent's session — a session created against a different managed
    // agent — without ever serializing against its runs.
    const first = createFakeClient({ streams: [[idleEndTurn]], sessionId: "sesn_first" });
    const second = createFakeClient({ streams: [[idleEndTurn]], sessionId: "sesn_second" });
    const store = new RecordingSessionStore();

    await collect(newAgent(first, store, { managedAgentId: "agent_a" }), baseInput());
    await collect(newAgent(second, store, { managedAgentId: "agent_b" }), baseInput({ runId: "run_2" }));

    // Each agent created and kept its own session.
    expect(first.spies.create).toHaveBeenCalledTimes(1);
    expect(second.spies.create).toHaveBeenCalledTimes(1);
    expect(store.keys().sort()).toEqual(["7:agent_a|0:|5:env_1|0:|thread_1", "7:agent_b|0:|5:env_1|0:|thread_1"]);
    expect(await store.get("7:agent_a|0:|5:env_1|0:|thread_1")).toMatchObject({ sessionId: "sesn_first" });
    expect(await store.get("7:agent_b|0:|5:env_1|0:|thread_1")).toMatchObject({ sessionId: "sesn_second" });
  });

  it("serializes runs on the same key that the store uses", async () => {
    const hold = gate();
    const fake = createFakeClient({ streams: [[hold.promise, idleEndTurn]] });
    const store = new RecordingSessionStore();
    const agent = newAgent(fake, store);

    const first = collect(agent, baseInput());
    await settle();
    const busy = (ManagedAgentsAgent as unknown as { busyThreadsByStore: WeakMap<object, Set<string>> })
      .busyThreadsByStore.get(store);
    expect([...(busy ?? [])]).toEqual([SESSION_KEY]);
    expect(store.keys()).toEqual([SESSION_KEY]);

    hold.release();
    await first;
  });

  it("does not create a session for a tool result on an unknown thread", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const events = await collect(
      newAgent(fake),
      baseInput({ messages: [{ id: "t1", role: "tool", toolCallId: "ctu_ghost", content: "late result" }] }),
    );
    expect(fake.spies.create).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "tool_result_without_session" });
  });

  it("rejects a blank thread id instead of sharing one session across callers", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new RecordingSessionStore();

    for (const threadId of ["", "   "]) {
      const events = await collect(newAgent(fake, store), baseInput({ threadId }));
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "invalid_thread_id" });
    }

    expect(fake.spies.create).not.toHaveBeenCalled();
    expect(store.keys()).toEqual([]);
  });

  it("errors with empty_run before creating a session when nothing is sendable", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const events = await collect(newAgent(fake), baseInput({ messages: [{ id: "a1", role: "assistant", content: "hi" }] }));
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "empty_run" });
    expect(fake.spies.create).not.toHaveBeenCalled();
  });

  it("errors with empty_run when the input has no messages or tools fields at all", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const input = baseInput() as Record<string, unknown>;
    delete input.messages;
    delete input.tools;

    const events = await collect(newAgent(fake), input as never);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "empty_run" });
    expect(fake.spies.create).not.toHaveBeenCalled();
  });

  it("errors with nothing_to_send when a run has nothing new", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    const store = new InMemorySessionStore();
    await store.set(SESSION_KEY, { sessionId: "sesn_1", toolNames: [], pendingClientToolUseIds: [], lastUserMessageId: "u1" });

    const events = await collect(newAgent(fake, store), baseInput());
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "nothing_to_send" });
    expect(fake.sent).toEqual([]);
  });

  it("updates the session's tools when the frontend adds a new one", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn], [idleEndTurn]] });
    const store = new InMemorySessionStore();
    await collect(newAgent(fake, store), baseInput());
    expect(fake.spies.update).not.toHaveBeenCalled();

    await collect(
      newAgent(fake, store),
      baseInput({
        runId: "run_2",
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "u2", role: "user", content: "Show me a chart" },
        ],
        tools: [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }],
      }),
    );

    expect(fake.spies.update.mock.calls[0]!.slice(0, 2)).toEqual([
      "sesn_1",
      {
        agent: {
          tools: [
            { type: "agent_toolset_20260401", configs: [], default_config: {} },
            { type: "custom", name: "show_chart", description: "Render a chart", input_schema: { type: "object" } },
          ],
        },
      },
    ]);
  });

  it("deletes the thread record when the session ends and starts fresh next run", async () => {
    const fake = createFakeClient({ streams: [[{ type: "session.status_terminated", id: "term_1" }], [idleEndTurn]] });
    const store = new InMemorySessionStore();

    const events = await collect(newAgent(fake, store), baseInput());
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "session_ended" });
    expect(await store.get(SESSION_KEY)).toBeUndefined();

    // The next run creates a fresh session.
    await collect(newAgent(fake, store), baseInput({ runId: "run_2" }));
    expect(fake.spies.create).toHaveBeenCalledTimes(2);
  });

  it("deletes the thread record when the session is deleted", async () => {
    const fake = createFakeClient({ streams: [[{ type: "session.deleted", id: "del_1" }]] });
    const store = new InMemorySessionStore();

    const events = await collect(newAgent(fake, store), baseInput());
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "session_ended" });
    expect(await store.get(SESSION_KEY)).toBeUndefined();
  });

  it("rejects a second concurrent run on the same thread with run_in_progress", async () => {
    const hold = gate();
    const fake = createFakeClient({ streams: [[hold.promise, idleEndTurn]] });
    const store = new InMemorySessionStore();

    const first = collect(newAgent(fake, store), baseInput());
    await settle(); // let the first run enter the busy section and open its stream

    const second = await collect(newAgent(fake, store), baseInput({ runId: "run_2" }));
    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "A run is already in progress on this thread.",
      code: "run_in_progress",
    });

    hold.release();
    expect((await first).at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("does not reject runs on the same thread id when the agents use different stores", async () => {
    // The busy gate is keyed by store identity: distinct stores are distinct
    // tenants, so one caller's slow run cannot block another's thread of the
    // same (client-supplied) id.
    const hold = gate();
    const slowFake = createFakeClient({ streams: [[hold.promise, idleEndTurn]] });
    const otherFake = createFakeClient({
      streams: [[{ type: "agent.message", id: "msg_1", content: [{ type: "text", text: "b" }] }, idleEndTurn]],
    });

    const first = collect(newAgent(slowFake, new InMemorySessionStore()), baseInput());
    await settle();

    const second = await collect(newAgent(otherFake, new InMemorySessionStore()), baseInput({ runId: "run_2" }));
    expect(second.at(-1)?.type).toBe(EventType.RUN_FINISHED);

    hold.release();
    expect((await first).at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("interrupts the session when the client disconnects mid-turn", async () => {
    const fake = createFakeClient({ streams: [[new Promise<void>(() => {})]] });
    const received: BaseEvent[] = [];

    const subscription = newAgent(fake).run(baseInput()).subscribe({ next: (event) => received.push(event) });
    await settle(); // stream open, user message posted
    expect(fake.sent).toHaveLength(1);

    subscription.unsubscribe();
    await settle(); // let the background interrupt land

    expect(allSentEvents(fake)).toContainEqual({ type: "user.interrupt" });
    // No RUN_ERROR reaches a client that already left, and nothing after the abort.
    expect(types(received)).not.toContain(EventType.RUN_ERROR);
    expect(types(received)).toEqual([EventType.RUN_STARTED, EventType.STATE_SNAPSHOT, EventType.CUSTOM]);
  });

  it("posts the interrupt before releasing the busy gate on disconnect", async () => {
    // A user who stops and immediately resends must not have the fresh run
    // killed by the previous run's late interrupt: the interrupt is posted
    // while the thread still reads busy.
    const fake = createFakeClient({ streams: [[new Promise<void>(() => {})]] });
    const store = new InMemorySessionStore();
    const agent = newAgent(fake, store);
    const busyWhenInterrupted: boolean[] = [];
    const originalSend = fake.client.beta.sessions.events.send;
    fake.client.beta.sessions.events.send = (async (sessionId: string, params: { events: unknown[] }) => {
      if (params.events.some((event) => (event as { type?: string }).type === "user.interrupt")) {
        const busy = (ManagedAgentsAgent as unknown as { busyThreadsByStore: WeakMap<object, Set<string>> })
          .busyThreadsByStore.get(store);
        busyWhenInterrupted.push(busy?.has(SESSION_KEY) ?? false);
      }
      return originalSend(sessionId, params);
    }) as typeof originalSend;

    const subscription = agent.run(baseInput()).subscribe({ next: () => {} });
    await settle();
    subscription.unsubscribe();
    await settle();

    expect(busyWhenInterrupted).toEqual([true]);
    const busyAfter = (ManagedAgentsAgent as unknown as { busyThreadsByStore: WeakMap<object, Set<string>> })
      .busyThreadsByStore.get(store);
    expect(busyAfter?.has(SESSION_KEY) ?? false).toBe(false);
  });

  it("interrupts the session and errors when the turn times out", async () => {
    const fake = createFakeClient({ streams: [[new Promise<void>(() => {})]] });
    const events = await collect(newAgent(fake, undefined, { turnTimeoutMs: 30 }), baseInput());

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "The turn exceeded the 0.03s limit and was interrupted.",
      code: "turn_timeout",
    });
    expect(allSentEvents(fake)).toContainEqual({ type: "user.interrupt" });
  });

  it("interrupts a backend tool that runs past the timeout instead of hanging", async () => {
    const handler = () => new Promise<string>(() => {}); // never resolves
    const fake = createFakeClient({
      streams: [[{ type: "agent.custom_tool_use", id: "ctu_1", name: "slow_tool", input: {} }, new Promise<void>(() => {})]],
    });
    const store = new InMemorySessionStore();
    const backendTools: BackendCustomTool[] = [{ name: "slow_tool", description: "", parameters: {}, handler }];

    const events = await collect(newAgent(fake, store, { backendTools, turnTimeoutMs: 30 }), baseInput());

    // The run ends with a timeout error rather than hanging forever...
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "The turn exceeded the 0.03s limit and was interrupted.",
      code: "turn_timeout",
    });
    // ...the parked tool is answered with an error so the session is not left waiting...
    expect(allSentEvents(fake)).toContainEqual({
      type: "user.custom_tool_result",
      custom_tool_use_id: "ctu_1",
      content: [{ type: "text", text: "Tool execution was interrupted." }],
      is_error: true,
    });
    // ...the session is interrupted, and the thread is free for the next run.
    expect(allSentEvents(fake)).toContainEqual({ type: "user.interrupt" });
    const next = await collect(
      newAgent(fake, store),
      baseInput({
        runId: "run_2",
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "u2", role: "user", content: "still there?" },
        ],
      }),
    );
    expect(next.at(-1)).not.toMatchObject({ code: "run_in_progress" });
  });

  it("interrupts a running backend tool when the client disconnects", async () => {
    const handler = () => new Promise<string>(() => {});
    const fake = createFakeClient({
      streams: [[{ type: "agent.custom_tool_use", id: "ctu_1", name: "slow_tool", input: {} }, new Promise<void>(() => {})]],
    });
    const backendTools: BackendCustomTool[] = [{ name: "slow_tool", description: "", parameters: {}, handler }];
    const received: BaseEvent[] = [];

    const subscription = newAgent(fake, undefined, { backendTools })
      .run(baseInput())
      .subscribe({ next: (event) => received.push(event) });
    await settle(); // reach the hung handler
    subscription.unsubscribe();
    await settle();

    expect(allSentEvents(fake)).toContainEqual({
      type: "user.custom_tool_result",
      custom_tool_use_id: "ctu_1",
      content: [{ type: "text", text: "Tool execution was interrupted." }],
      is_error: true,
    });
    expect(allSentEvents(fake)).toContainEqual({ type: "user.interrupt" });
    expect(types(received)).not.toContain(EventType.RUN_ERROR);
  });

  it("requests no previews when streamDeltas is false", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn]] });
    await collect(newAgent(fake, undefined, { streamDeltas: false }), baseInput());
    expect(fake.spies.stream.mock.calls[0]![1]).toEqual({});

    const withDeltas = createFakeClient({ streams: [[idleEndTurn]] });
    await collect(newAgent(withDeltas), baseInput());
    expect(withDeltas.spies.stream.mock.calls[0]![1]).toEqual({ event_deltas: ["agent.message", "agent.thinking"] });
  });

  it("makes turnTimeoutMs a real bound on every call it holds the gate for", async () => {
    // Regression: sessions.create, sessions.update, agents.retrieve and the
    // outbound sends were issued without the run's signal, so a stalled API call
    // held the thread's run gate open forever and turnTimeoutMs meant nothing.
    const store = new InMemorySessionStore();
    const created = createFakeClient({ streams: [[idleEndTurn]], createGate: new Promise<void>(() => {}) });
    const createEvents = await collect(newAgent(created, store, { turnTimeoutMs: 30 }), baseInput());
    expect(createEvents.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "turn_timeout" });

    const retrieved = createFakeClient({ streams: [[idleEndTurn]], retrieveGate: new Promise<void>(() => {}) });
    const retrieveEvents = await collect(
      newAgent(retrieved, new InMemorySessionStore(), { turnTimeoutMs: 30 }),
      baseInput({ tools: [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }] }),
    );
    expect(retrieveEvents.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "turn_timeout" });
  });

  it("passes the run signal to every session and agent call", async () => {
    const fake = createFakeClient({ streams: [[idleEndTurn], [idleEndTurn]] });
    const store = new InMemorySessionStore();
    const tools = [{ name: "show_chart", description: "Render a chart", parameters: { type: "object" } }];

    await collect(newAgent(fake, store), baseInput());
    // A second run whose tool list changed, so sessions.update runs too.
    await collect(
      newAgent(fake, store),
      baseInput({
        runId: "run_2",
        tools,
        messages: [
          { id: "u1", role: "user", content: "Hello" },
          { id: "u2", role: "user", content: "Show me a chart" },
        ],
      }),
    );

    expect(fake.callSignals.map((call) => call.call)).toEqual([
      "sessions.create",
      "agents.retrieve",
      "sessions.update",
    ]);
    for (const call of fake.callSignals) expect(call.signal, call.call).toBeInstanceOf(AbortSignal);
    // Every outbound send is bound too: either to the run or to its own timeout.
    for (const send of fake.sendOptions) expect(send.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds the turn's best-effort interrupt", async () => {
    // The interrupt runs while the gate is still held, so it must not reuse the
    // run's (already aborted) signal, and must not be unbounded either.
    const fake = createFakeClient({
      streams: [[{ type: "session.status_idle", id: "idle_1", stop_reason: { type: "requires_action", event_ids: ["mystery_1"] } }]],
    });
    const events = await collect(newAgent(fake), baseInput());

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "unsupported_action" });
    const interrupt = fake.sendOptions.find((send) =>
      send.events.some((event) => (event as { type?: string }).type === "user.interrupt"),
    );
    expect(interrupt?.signal).toBeInstanceOf(AbortSignal);
    expect(interrupt?.signal?.aborted).toBe(false);
  });

  it("surfaces a session-create failure as a run error without relaying its text", async () => {
    // The exception can carry session ids, request paths or credentials, and the
    // client is not necessarily a trusted operator surface: the cause belongs to
    // the hook, the client gets the code.
    const sensitive = "401 from https://internal.example/v1/sessions (key sk-ant-SECRET, session sesn_private)";
    const fake = createFakeClient({ createError: new Error(sensitive) });
    const reported: { error: unknown; context: { operation: string; threadId?: string } }[] = [];

    const events = await collect(
      newAgent(fake, undefined, { onError: (error, context) => void reported.push({ error, context }) }),
      baseInput(),
    );

    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: "The run failed.", code: "run_failed" });
    for (const event of events) expect(JSON.stringify(event)).not.toContain("sk-ant-SECRET");

    const reportedRun = reported.find((entry) => entry.context.operation === "run_failed");
    expect((reportedRun?.error as Error).message).toBe(sensitive);
    expect(reportedRun?.context.threadId).toBe("thread_1");
  });

  it("does not relay a failed delivery's exception text to the client", async () => {
    const sensitive = "500 from https://internal.example/v1/sessions/sesn_private/events (token sk-ant-SECRET)";
    const fake = createFakeClient({
      streams: [
        [
          { type: "agent.custom_tool_use", id: "ctu_1", name: "get_time", input: {} },
          idleEndTurn,
        ],
      ],
      // The user message posts fine; the tool result does not.
      sendResults: [undefined, new Error(sensitive)],
    });
    const reported: unknown[] = [];
    const backendTools: BackendCustomTool[] = [
      { name: "get_time", description: "", parameters: {}, handler: () => "noon" },
    ];

    const events = await collect(
      newAgent(fake, undefined, { backendTools, onError: (error) => void reported.push(error) }),
      baseInput(),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "The result of tool call ctu_1 could not be delivered to the session.",
      code: "tool_result_delivery_failed",
    });
    // Not in the RUN_ERROR, and no TOOL_CALL_RESULT was emitted at all.
    for (const event of events) expect(JSON.stringify(event)).not.toContain("sk-ant-SECRET");
    expect(types(events)).not.toContain(EventType.TOOL_CALL_RESULT);
    expect(reported.map((error) => (error as Error).message)).toContain(sensitive);
  });
});
