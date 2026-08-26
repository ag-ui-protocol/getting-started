/**
 * How `ToolCallStartEvent.parentMessageId` is derived.
 *
 * The parent must identify the assistant message that owns the tool call, so a
 * client can attach the call to the right bubble. With snapshots enabled that
 * is the assistant message the final `MESSAGES_SNAPSHOT` carries the call on,
 * which is deliberately NOT the id of the assistant text that preceded it.
 *
 * Driven through the real Strands SDK so the ids come from a genuine agent
 * turn rather than a hand-rolled event list.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  collect,
  expectNoRunError,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  recordingTool,
  snapshotsOf,
  toolStartsOf,
} from "./helpers";
import type { StrandsAgentConfig } from "../config";

const TOOL = "frontend_tool";
const CLIENT_TOOLS = [
  { name: TOOL, description: "d", parameters: {} },
] as never;
const BACKEND_TOOL = "backend_tool";
const AFTER_TOOL_TEXT = "after the tool";

async function run(
  turns: Parameters<typeof realStrandsAgent>[0],
  config?: StrandsAgentConfig,
) {
  const { agent } = realStrandsAgent(turns, { config });
  const events = await collect(
    agent,
    minimalRunInput({
      messages: [{ id: "u1", role: "user", content: "hello" } as never],
      tools: CLIENT_TOOLS,
    }),
  );
  // Interrogating events from a failed run would let a broken run satisfy
  // every parent assertion below.
  expectNoRunError(events);
  return events;
}

type TextEvent = BaseEvent & { messageId: string };
const lastTextEndId = (events: BaseEvent[]) =>
  (
    events.filter((e) => e.type === EventType.TEXT_MESSAGE_END) as TextEvent[]
  ).at(-1)?.messageId;

/** Id of the assistant message the final snapshot hangs `toolCallId` on. */
function snapshotOwnerId(events: BaseEvent[], toolCallId: string): string {
  const snapshots = snapshotsOf(events);
  const owner = snapshots
    .at(-1)!
    .messages.find(
      (m) =>
        m.role === "assistant" && m.toolCalls?.some((t) => t.id === toolCallId),
    );
  expect(
    owner,
    `tool call ${toolCallId} missing from the final snapshot`,
  ).toBeTruthy();
  return owner!.id;
}

const TEXT_THEN_TOOL = [
  modelTurn.textThenToolUse("Let me check:", {
    toolUseId: "st-1",
    name: TOOL,
    input: { ok: true },
  }),
];

describe("parentMessageId with MESSAGES_SNAPSHOT enabled", () => {
  it("points at the snapshot's tool-call assistant message", async () => {
    const events = await run(TEXT_THEN_TOOL);
    const starts = toolStartsOf(events, 1);
    const [start] = starts;
    expect(start.parentMessageId).toBe(
      snapshotOwnerId(events, start.toolCallId),
    );
  });

  it("does not reuse the preceding assistant text message id", async () => {
    const events = await run(TEXT_THEN_TOOL);
    const starts = toolStartsOf(events, 1);
    const [start] = starts;
    expect(lastTextEndId(events)).toBeTruthy();
    expect(start.parentMessageId, "parent regressed to undefined").toBeTruthy();
    expect(start.parentMessageId).not.toBe(lastTextEndId(events));
  });

  it("gives a tool call with no preceding text its own parent", async () => {
    const events = await run([
      modelTurn.toolUse({ toolUseId: "st-1", name: TOOL, input: {} }),
    ]);
    expect(events.map((e) => e.type)).not.toContain(
      EventType.TEXT_MESSAGE_START,
    );
    const starts = toolStartsOf(events, 1);
    const [start] = starts;
    expect(start.parentMessageId).toBeTruthy();
    expect(start.parentMessageId).toBe(
      snapshotOwnerId(events, start.toolCallId),
    );
  });
});

describe("parentMessageId with a custom argsStreamer", () => {
  // A custom argsStreamer takes the burst emit path rather than the streaming
  // one, and that path derives the parent separately. Without this the streaming path alone is covered and a
  // regression on the other branch ships unnoticed.
  const STREAMED_ARGS = '{"streamed":true}';
  async function* argsStreamer() {
    yield STREAMED_ARGS;
  }

  /**
   * Prove the run took the argsStreamer branch. The model's own input is
   * `{"ok":true}`, so seeing the streamer's payload on the wire is what
   * distinguishes the two paths; without it these tests pass unchanged when
   * the behavior is ignored.
   */
  function expectStreamerBranch(events: BaseEvent[]) {
    const args = events
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
      .map((e) => (e as BaseEvent & { delta: string }).delta)
      .join("");
    expect(args, "run did not take the argsStreamer branch").toBe(
      STREAMED_ARGS,
    );
  }

  it("points at the snapshot's tool-call assistant message", async () => {
    const events = await run(TEXT_THEN_TOOL, {
      toolBehaviors: { [TOOL]: { argsStreamer } },
    });
    expectStreamerBranch(events);
    const starts = toolStartsOf(events, 1);
    const [start] = starts;
    expect(start.parentMessageId).toBe(
      snapshotOwnerId(events, start.toolCallId),
    );
  });

  it("does not reuse the preceding assistant text message id", async () => {
    const events = await run(TEXT_THEN_TOOL, {
      toolBehaviors: { [TOOL]: { argsStreamer } },
    });
    expectStreamerBranch(events);
    const starts = toolStartsOf(events, 1);
    const [start] = starts;
    expect(lastTextEndId(events)).toBeTruthy();
    expect(start.parentMessageId, "parent regressed to undefined").toBeTruthy();
    expect(start.parentMessageId).not.toBe(lastTextEndId(events));
  });
});

describe("parentMessageId when a tool skips the snapshot", () => {
  // FINDING, pinned rather than fixed: the post-tool-call message id rotation
  // lives INSIDE the snapshot-emitting block, so skipping the snapshot also
  // skips the rotation. The tool call's parent is therefore the id the NEXT
  // assistant message will use, and it is wrong in two ways depending on
  // whether the run continues:
  //   - the run halts (client tool): no later message claims it, so the parent
  //     names nothing;
  //   - the run continues (backend tool): the next assistant message takes the
  //     same id, so the call attaches to the model's post-tool reply.
  // The second is the more damaging case: the client sees a confident and
  // wrong association rather than a missing one. The fix is to rotate outside
  // the snapshot branch; it belongs with whoever owns the snapshot contract.
  const SKIPPING = {
    toolBehaviors: { [TOOL]: { skipMessagesSnapshot: true } },
  };

  // A halting run is deliberately not pinned. With the snapshot skipped, no
  // snapshot carries the tool-call message id whether or not the rotation bug
  // exists, so such a test would pass before and after a fix. The two
  // continuing runs below are what actually discriminate.

  it("reuses the parent for the next assistant message when the run continues", async () => {
    const { tool } = recordingTool(BACKEND_TOOL);
    const { agent } = realStrandsAgent(
      [
        modelTurn.textThenToolUse("checking:", {
          toolUseId: "st-1",
          name: BACKEND_TOOL,
          input: {},
        }),
        modelTurn.text(AFTER_TOOL_TEXT),
      ],
      {
        tools: [tool],
        config: {
          toolBehaviors: { [BACKEND_TOOL]: { skipMessagesSnapshot: true } },
        },
      },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" } as never],
      }),
    );

    expectNoRunError(events);
    const starts = toolStartsOf(events, 1);
    const parent = starts[0].parentMessageId;
    expect(parent).toBeTruthy();

    const snapshots = snapshotsOf(events);
    const owner = snapshots.at(-1)!.messages.find((m) => m.id === parent);
    expect(owner, "parent resolved to no message").toBeDefined();
    // The parent points at the model's reply that FOLLOWED the tool call,
    // rather than at the assistant message that made the call.
    expect((owner as { content?: string }).content).toBe(AFTER_TOOL_TEXT);
  });

  it("leaks the parent to the next message with snapshots off globally", async () => {
    // Same root cause reached through the global flag rather than the per-tool
    // one, so a fix that only covers one path still shows up here.
    const { tool } = recordingTool(BACKEND_TOOL);
    const { agent } = realStrandsAgent(
      [
        modelTurn.textThenToolUse("checking:", {
          toolUseId: "st-1",
          name: BACKEND_TOOL,
          input: {},
        }),
        modelTurn.text(AFTER_TOOL_TEXT),
      ],
      { tools: [tool], config: { emitMessagesSnapshot: false } },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" } as never],
      }),
    );
    expectNoRunError(events);

    const parent = toolStartsOf(events, 1)[0].parentMessageId;
    expect(parent).toBeTruthy();
    const textStartIds = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_START)
      .map((e) => (e as BaseEvent & { messageId: string }).messageId);
    // The assistant message that follows the tool call takes the same id.
    expect(textStartIds.at(-1)).toBe(parent);
  });
});

describe("parentMessageId for parallel tool calls", () => {
  const PARALLEL = [
    modelTurn.textThenToolUse(
      "Calling two tools:",
      { toolUseId: "st-a", name: TOOL, input: {} },
      { toolUseId: "st-b", name: TOOL, input: {} },
    ),
  ];

  it("gives each call a parent that owns it in the snapshot", async () => {
    const events = await run(PARALLEL);
    const starts = toolStartsOf(events, 2);
    for (const start of starts) {
      expect(start.parentMessageId).toBe(
        snapshotOwnerId(events, start.toolCallId),
      );
    }
  });

  // Recorded, not endorsed: with snapshots on, one model turn's parallel calls
  // become one assistant message per call, while the snapshot-off path below
  // gives the same turn a single shared parent. The two paths disagree about
  // how many assistant messages a turn produces. Pinning it here means a
  // deliberate change to either path shows up as a failure rather than as a
  // silent shift in what clients receive.
  it("puts each call on its own assistant message", async () => {
    const events = await run(PARALLEL);
    const starts = toolStartsOf(events, 2);
    expect(starts[0].parentMessageId).not.toBe(starts[1].parentMessageId);
  });

  it("shares one parent across the turn when snapshots are off", async () => {
    const events = await run(PARALLEL, { emitMessagesSnapshot: false });
    const starts = toolStartsOf(events, 2);
    expect(starts[0].parentMessageId).toBe(starts[1].parentMessageId);
    expect(starts[0].parentMessageId).toBeTruthy();
  });
});

describe("parentMessageId with MESSAGES_SNAPSHOT disabled", () => {
  const NO_SNAPSHOT = { emitMessagesSnapshot: false };

  it("still emits a parent and no snapshot", async () => {
    const events = await run(TEXT_THEN_TOOL, NO_SNAPSHOT);
    expect(
      events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toEqual([]);
    expect(toolStartsOf(events, 1)[0].parentMessageId).toBeTruthy();
  });

  // The Python bridge reuses the preceding text message id as the parent when
  // snapshots are off, and leaves the parent unset when no assistant text
  // preceded the call. TypeScript rotates to a fresh id unconditionally. This
  // is a cross-bridge divergence owned elsewhere, so the TypeScript behaviour
  // is pinned positively rather than fixed here: these assertions fail if the
  // bridges converge, and a crash stays a crash instead of reading as
  // "still diverged" the way an it.fails marker would.
  it("rotates to a fresh parent instead of reusing the preceding text id", async () => {
    const events = await run(TEXT_THEN_TOOL, NO_SNAPSHOT);
    const starts = toolStartsOf(events, 1);
    expect(lastTextEndId(events), "no TEXT_MESSAGE_END emitted").toBeTruthy();
    expect(starts[0].parentMessageId).toBeTruthy();
    // Python asserts equality here.
    expect(starts[0].parentMessageId).not.toBe(lastTextEndId(events));
  });

  it("still emits a parent when no assistant text preceded the call", async () => {
    const events = await run(
      [modelTurn.toolUse({ toolUseId: "st-1", name: TOOL, input: {} })],
      NO_SNAPSHOT,
    );
    expect(events.map((e) => e.type)).not.toContain(
      EventType.TEXT_MESSAGE_START,
    );
    const starts = toolStartsOf(events, 1);
    // Python leaves this undefined.
    expect(starts[0].parentMessageId).toBeTruthy();
  });
});
