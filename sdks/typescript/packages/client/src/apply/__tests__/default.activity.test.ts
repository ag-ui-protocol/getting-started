import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import { AgentStateMutation } from "@/agent/subscriber";

// defaultApplyEvents only reads agent.messages (and passes agent to subscriber
// callbacks which are empty in these tests), so a partial stub is sufficient.
// AbstractAgent is an abstract class — a full subclass would add noise.
const createAgent = (messages: Message[] = []) =>
  ({ messages: messages.map((m) => ({ ...m })), state: {} }) as unknown as AbstractAgent;

const makeInput = (messages: Message[] = []): RunAgentInput => ({
  messages,
  state: {},
  threadId: "thread-test",
  runId: "run-test",
  tools: [],
  context: [],
});

/** Emit events into defaultApplyEvents and collect all state mutations. */
async function emitAndCollect(
  initial: Message[],
  emit: (events$: Subject<BaseEvent>) => void,
): Promise<AgentStateMutation[]> {
  const events$ = new Subject<BaseEvent>();
  const agent = createAgent(initial);
  const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
  const updatesPromise = firstValueFrom(result$.pipe(toArray()));
  emit(events$);
  events$.complete();
  return updatesPromise;
}

/** Shorthand: apply a single MESSAGES_SNAPSHOT and return the resulting messages. */
async function applySnapshot(initial: Message[], snapshotMessages: Message[]): Promise<Message[]> {
  const updates = await emitAndCollect(initial, (events$) => {
    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: snapshotMessages,
    });
  });
  return updates[0]?.messages!;
}

describe("defaultApplyEvents with activity events", () => {
  it("creates and updates activity messages via snapshot and delta", async () => {
    const updates = await emitAndCollect([], (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["search"] },
      });

      events$.next({
        type: EventType.ACTIVITY_DELTA,
        messageId: "activity-1",
        activityType: "PLAN",
        patch: [{ op: "replace", path: "/tasks/0", value: "✓ search" }],
      });
    });

    expect(updates.length).toBe(2);

    const snapshotUpdate = updates[0];
    expect(snapshotUpdate?.messages?.[0]?.role).toBe("activity");
    expect(snapshotUpdate?.messages?.[0]?.activityType).toBe("PLAN");
    expect(snapshotUpdate?.messages?.[0]?.content).toEqual({ tasks: ["search"] });

    const deltaUpdate = updates[1];
    expect(deltaUpdate?.messages?.[0]?.content).toEqual({ tasks: ["✓ search"] });
  });

  it("appends operations via delta when snapshot starts with an empty array", async () => {
    const firstOperation = { id: "op-1", status: "PENDING" };
    const secondOperation = { id: "op-2", status: "COMPLETED" };

    const updates = await emitAndCollect([], (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-ops",
        activityType: "PLAN",
        content: { operations: [] },
      });

      events$.next({
        type: EventType.ACTIVITY_DELTA,
        messageId: "activity-ops",
        activityType: "PLAN",
        patch: [{ op: "add", path: "/operations/-", value: firstOperation }],
      });

      events$.next({
        type: EventType.ACTIVITY_DELTA,
        messageId: "activity-ops",
        activityType: "PLAN",
        patch: [{ op: "add", path: "/operations/-", value: secondOperation }],
      });
    });

    expect(updates.length).toBe(3);
    expect(updates[0]?.messages?.[0]?.content).toEqual({ operations: [] });
    expect(updates[1]?.messages?.[0]?.content?.operations).toEqual([firstOperation]);
    expect(updates[2]?.messages?.[0]?.content?.operations).toEqual([
      firstOperation,
      secondOperation,
    ]);
  });

  it("does not replace existing activity message when replace is false", async () => {
    const initial = [
      { id: "activity-1", role: "activity", activityType: "PLAN", content: { tasks: ["initial"] } },
    ] as Message[];

    const updates = await emitAndCollect(initial, (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["updated"] },
        replace: false,
      });
    });

    expect(updates.length).toBe(1);
    expect(updates[0]?.messages?.[0]?.content).toEqual({ tasks: ["initial"] });
  });

  it("adds activity message when replace is false and none exists", async () => {
    const updates = await emitAndCollect([], (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["first"] },
        replace: false,
      });
    });

    expect(updates.length).toBe(1);
    expect(updates[0]?.messages?.[0]?.content).toEqual({ tasks: ["first"] });
    expect(updates[0]?.messages?.[0]?.role).toBe("activity");
  });

  it("replaces existing activity message when replace is true", async () => {
    const initial = [
      {
        id: "activity-1",
        role: "activity" as const,
        activityType: "PLAN",
        content: { tasks: ["initial"] },
      },
    ] as Message[];

    const updates = await emitAndCollect(initial, (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["updated"] },
        replace: true,
      });
    });

    expect(updates.length).toBe(1);
    expect(updates[0]?.messages?.[0]?.content).toEqual({ tasks: ["updated"] });
  });

  it("replaces non-activity message when replace is true", async () => {
    const initial = [
      { id: "activity-1", role: "user" as const, content: "placeholder" },
    ] as Message[];

    const updates = await emitAndCollect(initial, (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["first"] },
        replace: true,
      });
    });

    expect(updates.length).toBe(1);
    expect(updates[0]?.messages?.[0]?.role).toBe("activity");
    expect(updates[0]?.messages?.[0]?.content).toEqual({ tasks: ["first"] });
  });

  it("does not alter non-activity message when replace is false", async () => {
    const initial = [
      { id: "activity-1", role: "user" as const, content: "placeholder" },
    ] as Message[];

    const updates = await emitAndCollect(initial, (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["first"] },
        replace: false,
      });
    });

    expect(updates.length).toBe(1);
    expect(updates[0]?.messages?.[0]?.role).toBe("user");
    expect(updates[0]?.messages?.[0]?.content).toBe("placeholder");
  });

  it("maintains replace semantics across runs", async () => {
    const firstUpdates = await emitAndCollect([], (events$) => {
      events$.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "PLAN",
        content: { tasks: ["initial"] },
        replace: true,
      });
    });

    const nextMessages = firstUpdates[0]?.messages ?? [];

    const secondRunEvents$ = new Subject<BaseEvent>();
    const secondAgent = createAgent(nextMessages);
    const secondResult$ = defaultApplyEvents(
      makeInput(nextMessages),
      secondRunEvents$,
      secondAgent,
      [],
    );
    const secondUpdatesPromise = firstValueFrom(secondResult$.pipe(toArray()));

    secondRunEvents$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["updated"] },
      replace: false,
    });

    secondRunEvents$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["final"] },
      replace: true,
    });

    secondRunEvents$.complete();

    const secondUpdates = await secondUpdatesPromise;
    expect(secondUpdates.length).toBe(2);
    expect(secondUpdates[0]?.messages?.[0]?.content).toEqual({ tasks: ["initial"] });
    expect(secondUpdates[1]?.messages?.[0]?.content).toEqual({ tasks: ["final"] });
  });
});

describe("MESSAGES_SNAPSHOT preserves client-only messages", () => {
  it("preserves activity message between conversation messages", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["a"] } },
        { id: "m2", role: "assistant", content: "hi" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: "hi" },
      ],
    );

    expect(msgs.length).toBe(3);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "m2"]);
    expect(msgs[1].role).toBe("activity");
  });

  it("keeps activity message ordering after its anchor", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "q1" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { x: 1 } },
        { id: "m2", role: "assistant", content: "a1" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "q1" },
        { id: "m2", role: "assistant", content: "a1" },
      ],
    );

    expect(msgs[0].id).toBe("m1");
    expect(msgs[1].id).toBe("act-1");
    expect(msgs[2].id).toBe("m2");
  });

  it("preserves activity at start of messages (null anchor)", async () => {
    const msgs = await applySnapshot(
      [
        { id: "act-0", role: "activity", activityType: "PLAN", content: { step: 0 } },
        { id: "m1", role: "user", content: "hello" },
      ] as Message[],
      [{ id: "m1", role: "user", content: "hello" }],
    );

    expect(msgs.length).toBe(2);
    expect(msgs[0].id).toBe("act-0");
    expect(msgs[1].id).toBe("m1");
  });

  it("preserves multiple activities with different anchors", async () => {
    const msgs = await applySnapshot(
      [
        { id: "act-a", role: "activity", activityType: "PLAN", content: { a: 1 } },
        { id: "m1", role: "user", content: "q" },
        { id: "act-b", role: "activity", activityType: "PLAN", content: { b: 2 } },
        { id: "m2", role: "assistant", content: "a" },
        { id: "act-c", role: "activity", activityType: "PLAN", content: { c: 3 } },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "q" },
        { id: "m2", role: "assistant", content: "a" },
      ],
    );

    expect(msgs.map((m) => m.id)).toEqual(["act-a", "m1", "act-b", "m2", "act-c"]);
  });

  it("preserves activity position when its preceding message is removed", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "q" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { x: 1 } },
        { id: "m2", role: "assistant", content: "a" },
      ] as Message[],
      [{ id: "m2", role: "assistant", content: "a" }],
    );

    expect(msgs.length).toBe(2);
    expect(msgs[0].id).toBe("act-1");
    expect(msgs[1].id).toBe("m2");
  });

  it("keeps activities in position when new messages are added by snapshot", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "q" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { x: 1 } },
        { id: "m2", role: "assistant", content: "a" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "q" },
        { id: "m2", role: "assistant", content: "a" },
        { id: "m3", role: "user", content: "q2" },
      ],
    );

    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "m2", "m3"]);
  });

  it("preserves reasoning messages after MESSAGES_SNAPSHOT", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "r1", role: "reasoning", content: "Let me think about this..." },
        { id: "m2", role: "assistant", content: "hi there" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: "hi there" },
      ],
    );

    expect(msgs.length).toBe(3);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "r1", "m2"]);
    expect(msgs[1].role).toBe("reasoning");
    expect(msgs[1].content).toBe("Let me think about this...");
  });

  it("preserves both activity and reasoning messages after MESSAGES_SNAPSHOT", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "explain this" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["research"] } },
        { id: "r1", role: "reasoning", content: "The user wants an explanation..." },
        { id: "m2", role: "assistant", content: "Here is the explanation" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "explain this" },
        { id: "m2", role: "assistant", content: "Here is the explanation" },
      ],
    );

    expect(msgs.length).toBe(4);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "r1", "m2"]);
    expect(msgs[1].role).toBe("activity");
    expect(msgs[2].role).toBe("reasoning");
  });

  it("reasoning messages are not replaced by snapshot data", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "r1", role: "reasoning", content: "original reasoning" },
        { id: "m2", role: "assistant", content: "response" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: "response" },
      ],
    );

    const reasoning = msgs.find((m) => m.id === "r1")!;
    expect(reasoning.role).toBe("reasoning");
    expect(reasoning.content).toBe("original reasoning");
  });

  it("preserves activity position when a message ID changes in snapshot", async () => {
    // Simulates the real-world scenario: streaming creates a tool message with ID "tool-stream",
    // but MESSAGES_SNAPSHOT has the same tool message with a different canonical ID "tool-canon".
    // The activity stays in its original position; the renamed message is appended as new.
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "create a dashboard" },
        { id: "asst-1", role: "assistant", content: "I'll create that for you" },
        { id: "tool-stream", role: "tool", content: '{"a2ui": true}' },
        {
          id: "act-1",
          role: "activity",
          activityType: "A2UI_SURFACE",
          content: { surface: "dashboard" },
        },
        { id: "asst-2", role: "assistant", content: "Here's your dashboard" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "create a dashboard" },
        { id: "asst-1", role: "assistant", content: "I'll create that for you" },
        { id: "tool-canon", role: "tool", content: '{"a2ui": true}' },
        { id: "asst-2", role: "assistant", content: "Here's your dashboard" },
      ],
    );

    expect(msgs.map((m) => m.id)).toEqual(["m1", "asst-1", "act-1", "asst-2", "tool-canon"]);
  });
});

describe("MESSAGES_SNAPSHOT with snapshot-supplied reasoning", () => {
  // When the backend includes reasoning in the snapshot (e.g. LangGraph
  // re-deriving it from checkpointed content blocks), the snapshot is the
  // source of truth for reasoning: the streamed copy — which carries a
  // different, locally-generated id — must be replaced, not kept alongside.

  it("replaces streamed reasoning with the snapshot's canonical copy when ids differ", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "What is the best car to buy?" },
        { id: "uuid-a", role: "reasoning", content: "The user wants a car recommendation." },
        { id: "lc-1", role: "assistant", content: "Based on my analysis…" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "What is the best car to buy?" },
        { id: "rs-1", role: "reasoning", content: "The user wants a car recommendation." },
        { id: "resp-1", role: "assistant", content: "Based on my analysis…" },
      ],
    );

    expect(msgs.filter((m) => m.role === "reasoning").length).toBe(1);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "rs-1", "resp-1"]);
  });

  it("replaces streamed reasoning when the snapshot arrives before the assistant streamed", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "What is the best car to buy?" },
        { id: "uuid-a", role: "reasoning", content: "The user wants a car recommendation." },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "What is the best car to buy?" },
        { id: "rs-1", role: "reasoning", content: "The user wants a car recommendation." },
        { id: "resp-1", role: "assistant", content: "Based on my analysis…" },
      ],
    );

    expect(msgs.filter((m) => m.role === "reasoning").length).toBe(1);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "rs-1", "resp-1"]);
  });

  it("converges multi-turn reasoning to one message per turn", async () => {
    // Models turn 2 of the real flow: turn 1 already converged to canonical
    // ids via its own end-of-run snapshot; turn 2's streamed reasoning and
    // assistant still carry locally-generated ids.
    const msgs = await applySnapshot(
      [
        { id: "u1", role: "user", content: "q1" },
        { id: "rs-1", role: "reasoning", content: "thinking about q1" },
        { id: "resp-1", role: "assistant", content: "a1" },
        { id: "u2", role: "user", content: "q2" },
        { id: "uuid-b", role: "reasoning", content: "thinking about q2" },
        { id: "lc-2", role: "assistant", content: "a2" },
      ] as Message[],
      [
        { id: "u1", role: "user", content: "q1" },
        { id: "rs-1", role: "reasoning", content: "thinking about q1" },
        { id: "resp-1", role: "assistant", content: "a1" },
        { id: "u2", role: "user", content: "q2" },
        { id: "rs-2", role: "reasoning", content: "thinking about q2" },
        { id: "resp-2", role: "assistant", content: "a2" },
      ],
    );

    expect(msgs.filter((m) => m.role === "reasoning").length).toBe(2);
    expect(msgs.map((m) => m.id)).toEqual(["u1", "rs-1", "resp-1", "u2", "rs-2", "resp-2"]);
  });

  it("still preserves activity messages when the snapshot carries reasoning", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["a"] } },
        { id: "uuid-a", role: "reasoning", content: "thinking" },
        { id: "lc-1", role: "assistant", content: "hi" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "rs-1", role: "reasoning", content: "thinking" },
        { id: "resp-1", role: "assistant", content: "hi" },
      ],
    );

    expect(msgs.filter((m) => m.role === "activity").length).toBe(1);
    expect(msgs.filter((m) => m.role === "reasoning").length).toBe(1);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "rs-1", "resp-1"]);
  });

  it("updates an id-stable reasoning message with the snapshot version", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "r1", role: "reasoning", content: "thinking" },
        { id: "a1", role: "assistant", content: "hi" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "r1", role: "reasoning", content: "thinking", encryptedValue: "enc-1" } as Message,
        { id: "a1", role: "assistant", content: "hi" },
      ],
    );

    expect(msgs.filter((m) => m.role === "reasoning").length).toBe(1);
    const reasoning = msgs.find((m) => m.id === "r1")! as { encryptedValue?: string };
    expect(reasoning.encryptedValue).toBe("enc-1");
  });
});

describe("MESSAGES_SNAPSHOT with snapshot-supplied activity", () => {
  // A snapshot is a snapshot of every message, so once it carries any activity
  // the backend is declaring the complete activity set: entries it repeats are
  // replaced and ones it leaves out are dropped. A snapshot that carries no
  // activity says nothing about it, and the client's activity is preserved —
  // the same all-or-nothing rule `snapshotHasReasoning` applies to reasoning.

  it("replaces an existing activity message with the snapshot version", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["stale"] } },
        { id: "a1", role: "assistant", content: "hi" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["fresh"] } },
        { id: "a1", role: "assistant", content: "hi" },
      ] as Message[],
    );

    expect(msgs.filter((m) => m.role === "activity").length).toBe(1);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "a1"]);
    const activity = msgs.find((m) => m.id === "act-1")! as { content?: { tasks?: string[] } };
    expect(activity.content?.tasks).toEqual(["fresh"]);
  });

  it("appends an activity message the client does not have yet", async () => {
    const msgs = await applySnapshot(
      [{ id: "m1", role: "user", content: "hello" }] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["fresh"] } },
      ] as Message[],
    );

    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1"]);
    const activity = msgs.find((m) => m.id === "act-1")! as { content?: { tasks?: string[] } };
    expect(activity.content?.tasks).toEqual(["fresh"]);
  });

  it("drops a local activity the snapshot leaves out once the snapshot carries activity", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-gone", role: "activity", activityType: "PLAN", content: { tasks: ["gone"] } },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["stale"] } },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["fresh"] } },
      ] as Message[],
    );

    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1"]);
    const activity = msgs.find((m) => m.id === "act-1")! as { content?: { tasks?: string[] } };
    expect(activity.content?.tasks).toEqual(["fresh"]);
  });

  it("keeps client activity when the snapshot carries none", async () => {
    const msgs = await applySnapshot(
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["local"] } },
        { id: "a1", role: "assistant", content: "hi" },
      ] as Message[],
      [
        { id: "m1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "hi" },
      ] as Message[],
    );

    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "a1"]);
    const activity = msgs.find((m) => m.id === "act-1")! as { content?: { tasks?: string[] } };
    expect(activity.content?.tasks).toEqual(["local"]);
  });
});
