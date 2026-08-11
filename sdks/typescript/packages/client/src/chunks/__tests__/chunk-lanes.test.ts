import { from, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { transformChunks } from "../transform";
import { verifyEvents } from "../../verify/verify";
import { BaseEvent, EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

/**
 * The chunk shorthand assembles START/CONTENT/END from a single stream of chunks, and it
 * used to keep ONE pending stream for the whole run. Two subagents streaming at once
 * therefore destroyed each other: the second one's opening chunk closed the first one's
 * message, and since a continuation chunk omits the id, the first subagent's next chunk
 * failed outright. These tests pin the per-lane behaviour that replaced it, where a lane
 * is the subagent a chunk is attributed to and `undefined` is the parent agent.
 */

// Chunk events are constructed loosely on purpose: the point of most of these cases is a
// shape a producer can legally send, including ones the strict types discourage.
const run = (...events: unknown[]): Promise<BaseEvent[]> =>
  firstValueFrom(
    transformChunks(false)(from(events as BaseEvent[])).pipe(toArray()),
  ) as Promise<BaseEvent[]>;

/** Compact view of the synthesized stream: type, entity id, delta, owner. */
const shape = (events: BaseEvent[]) =>
  events.map((event) => {
    const e = event as Record<string, unknown>;
    return [
      e.type as string,
      (e.messageId ?? e.toolCallId ?? "") as string,
      (e.delta ?? "") as string,
      (e.subagentRunId ?? null) as string | null,
    ];
  });

const textChunk = (delta: string, subagentRunId?: string, messageId?: string) => ({
  type: EventType.TEXT_MESSAGE_CHUNK,
  ...(messageId !== undefined && { messageId, role: "assistant" }),
  delta,
  ...(subagentRunId !== undefined && { subagentRunId }),
});

const toolChunk = (delta: string, subagentRunId?: string, toolCallId?: string) => ({
  type: EventType.TOOL_CALL_CHUNK,
  ...(toolCallId !== undefined && { toolCallId, toolCallName: "fn" }),
  delta,
  ...(subagentRunId !== undefined && { subagentRunId }),
});

const reasoningChunk = (delta: string, subagentRunId?: string, messageId?: string) => ({
  type: EventType.REASONING_MESSAGE_CHUNK,
  ...(messageId !== undefined && { messageId }),
  delta,
  ...(subagentRunId !== undefined && { subagentRunId }),
});

const RUN_FINISHED = { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" };
const RUN_STARTED = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" };

describe("transformChunks lanes: concurrent subagents", () => {
  it("keeps both subagents' text messages open when their chunks interleave", async () => {
    // The original defect. m2's opener used to close m1, and "C" — which names no
    // message, meaning "the same as before" — then had nothing valid to continue.
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("B", "s2", "m2"),
      textChunk("C", "s1"),
      RUN_FINISHED,
    );

    expect(shape(events)).toEqual([
      [EventType.TEXT_MESSAGE_START, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_START, "m2", "", "s2"],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "B", "s2"],
      // m1 was never closed, so its continuation lands on it.
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "C", "s1"],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_END, "m2", "", "s2"],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });

  it("keeps three subagents' messages independent", async () => {
    const events = await run(
      textChunk("1", "s1", "m1"),
      textChunk("2", "s2", "m2"),
      textChunk("3", "s3", "m3"),
      textChunk("1b", "s1"),
      textChunk("3b", "s3"),
      textChunk("2b", "s2"),
      RUN_FINISHED,
    );

    const contents = shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT);
    expect(contents).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "1", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "2", "s2"],
      [EventType.TEXT_MESSAGE_CONTENT, "m3", "3", "s3"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "1b", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m3", "3b", "s3"],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "2b", "s2"],
    ]);
    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END)).toHaveLength(3);
  });

  it("does not let one subagent's tool chunk close another's text message", async () => {
    // The global `mode` was the second half of the defect: only one FAMILY could be open
    // at a time, so a tool chunk anywhere ended an unrelated text message.
    const events = await run(
      textChunk("A", "s1", "m1"),
      toolChunk("{", "s2", "c1"),
      textChunk("B", "s1"),
      RUN_FINISHED,
    );

    expect(shape(events)).toEqual([
      [EventType.TEXT_MESSAGE_START, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TOOL_CALL_START, "c1", "", "s2"],
      [EventType.TOOL_CALL_ARGS, "c1", "{", "s2"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", "s1"],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.TOOL_CALL_END, "c1", "", "s2"],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });

  it("keeps the parent's own stream separate from a subagent's", async () => {
    const events = await run(
      textChunk("P", undefined, "p1"),
      textChunk("A", "s1", "m1"),
      textChunk("Q"),
      RUN_FINISHED,
    );

    // The untagged continuation belongs to the parent, which is what "no tag" means.
    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "P", null],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "Q", null],
    ]);
  });

  it("keeps two subagents' tool calls independent", async () => {
    const events = await run(
      toolChunk('{"a', "s1", "c1"),
      toolChunk('{"b', "s2", "c2"),
      toolChunk('":1}', "s1"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TOOL_CALL_ARGS)).toEqual([
      [EventType.TOOL_CALL_ARGS, "c1", '{"a', "s1"],
      [EventType.TOOL_CALL_ARGS, "c2", '{"b', "s2"],
      [EventType.TOOL_CALL_ARGS, "c1", '":1}', "s1"],
    ]);
  });

  it("keeps two subagents' reasoning messages independent", async () => {
    const events = await run(
      reasoningChunk("A", "s1", "m1"),
      reasoningChunk("B", "s2", "m2"),
      reasoningChunk("C", "s1"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.REASONING_MESSAGE_CONTENT)).toEqual([
      [EventType.REASONING_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.REASONING_MESSAGE_CONTENT, "m2", "B", "s2"],
      [EventType.REASONING_MESSAGE_CONTENT, "m1", "C", "s1"],
    ]);
  });
});

describe("transformChunks lanes: resolving which lane a chunk belongs to", () => {
  it("continues the sole open stream when a chunk carries neither id nor tag", async () => {
    // Back-compat for producers that attribute only the opening chunk.
    const events = await run(textChunk("A", "s1", "m1"), textChunk("B"), RUN_FINISHED);

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", "s1"],
    ]);
  });

  it("rejects an untagged, unnamed continuation when more than one lane could own it", async () => {
    // Two candidates and nothing to choose between them. Picking one would silently
    // misattribute half a message, which a consumer renders under the wrong subagent.
    await expect(
      run(textChunk("A", "s1", "m1"), textChunk("B", "s2", "m2"), textChunk("C")),
    ).rejects.toThrow(/Ambiguous TEXT_MESSAGE_CHUNK.*2 lanes have an open text message/);
  });

  it("rejects an ambiguous unnamed tool chunk", async () => {
    await expect(
      run(toolChunk("a", "s1", "c1"), toolChunk("b", "s2", "c2"), toolChunk("c")),
    ).rejects.toThrow(/Ambiguous TOOL_CALL_CHUNK.*neither a toolCallId/);
  });

  it("rejects an ambiguous unnamed reasoning chunk", async () => {
    await expect(
      run(reasoningChunk("a", "s1", "m1"), reasoningChunk("b", "s2", "m2"), reasoningChunk("c")),
    ).rejects.toThrow(/Ambiguous REASONING_MESSAGE_CHUNK.*2 lanes have an open reasoning message/);
  });

  it("prefers the parent's stream over a subagent's for an untagged continuation", async () => {
    // Both lanes are open, so the fallback would be ambiguous — but "no tag" names the
    // parent outright, so there is nothing to guess.
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("P", undefined, "p1"),
      textChunk("Q"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "P", null],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "Q", null],
    ]);
  });

  it("continues a named message from an untagged chunk, since the id is unambiguous", async () => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("B", "s2", "m2"),
      // Names m1 but carries no tag. An absent tag never disagrees, so it inherits s1.
      textChunk("C", undefined, "m1"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "B", "s2"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "C", "s1"],
    ]);
  });

  it("routes a tagged, unnamed continuation to its own lane even while others are open", async () => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("P", undefined, "p1"),
      textChunk("B", "s1"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "P", null],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", "s1"],
    ]);
  });

  it("continues the sole open text stream when the parent's open stream is a DIFFERENT kind", async () => {
    // The parent has a tool call in flight and s1 has the only open text message. An
    // id-less, tag-less text chunk cannot OPEN a parent message (a first chunk must
    // carry its id, the transform throws), so s1's message is the only stream it can
    // possibly continue — the sole-candidate fallback applies even though the parent
    // lane is not empty. Pinned deliberately: narrowing the fallback to "parent has
    // nothing open at all" would look like a tightening but would hard-fail this
    // perfectly legal opener-only-tagging stream.
    const events = await run(
      toolChunk("{", undefined, "c1"),
      textChunk("A", "s1", "m1"),
      textChunk("B"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", "s1"],
    ]);
    // The parent's tool call was untouched by the text traffic.
    expect(shape(events).filter((e) => e[0] === EventType.TOOL_CALL_END)).toEqual([
      [EventType.TOOL_CALL_END, "c1", "", null],
    ]);
  });

  it("still requires an id for the first chunk in a lane", async () => {
    // s2 has nothing open, so "the same as before" has no referent even though the tag
    // is unambiguous.
    await expect(run(textChunk("A", "s1", "m1"), textChunk("B", "s2"))).rejects.toThrow(
      "First TEXT_MESSAGE_CHUNK must have a messageId",
    );
  });

  it("closes the previous stream when a new id opens in the SAME lane", async () => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("B", "s1", "m2"),
      RUN_FINISHED,
    );

    expect(shape(events)).toEqual([
      [EventType.TEXT_MESSAGE_START, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_START, "m2", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "B", "s1"],
      [EventType.TEXT_MESSAGE_END, "m2", "", "s1"],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });

  it("closes a lane's text stream when the same lane switches to reasoning", async () => {
    // Within one lane the old single-stream rule still holds: a lane assembles one
    // thing at a time.
    const events = await run(textChunk("A", "s1", "m1"), reasoningChunk("R", "s1", "r1"), RUN_FINISHED);

    expect(shape(events)).toEqual([
      [EventType.TEXT_MESSAGE_START, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.REASONING_MESSAGE_START, "r1", "", "s1"],
      [EventType.REASONING_MESSAGE_CONTENT, "r1", "R", "s1"],
      [EventType.REASONING_MESSAGE_END, "r1", "", "s1"],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });

  it("rejects a tag that disagrees with the lane already holding the id", async () => {
    await expect(
      run(textChunk("A", "s1", "m1"), textChunk("B", "s2", "m1")),
    ).rejects.toThrow(/does not match the open stream's subagent 's1'/);
  });

  it("rejects a disagreeing tag on a tool call", async () => {
    await expect(run(toolChunk("a", "s1", "c1"), toolChunk("b", "s2", "c1"))).rejects.toThrow(
      /Cannot continue tool call 'c1'.*does not match the open stream's subagent 's1'/,
    );
  });

  it("rejects a disagreeing tag on a reasoning message", async () => {
    await expect(
      run(reasoningChunk("a", "s1", "m1"), reasoningChunk("b", "s2", "m1")),
    ).rejects.toThrow(/Cannot continue reasoning message 'm1'/);
  });

  it("rejects a subagent-tagged chunk continuing the parent's stream", async () => {
    // A stream with no owner belongs to the parent, which is as much an owner as a
    // subagent — so a tagged chunk on it does disagree.
    await expect(
      run(textChunk("A", undefined, "p1"), textChunk("B", "s1", "p1")),
    ).rejects.toThrow(/does not match the open stream's subagent '\(the parent agent\)'/);
  });
});

describe("transformChunks lanes: closing", () => {
  it("closes only the finishing subagent's lane", async () => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("B", "s2", "m2"),
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" },
      textChunk("C", "s2"),
      RUN_FINISHED,
    );

    expect(shape(events)).toEqual([
      [EventType.TEXT_MESSAGE_START, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_START, "m2", "", "s2"],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "B", "s2"],
      // s1's message is closed BEFORE its terminal, and s2 is untouched.
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.SUBAGENT_FINISHED, "", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "C", "s2"],
      [EventType.TEXT_MESSAGE_END, "m2", "", "s2"],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });

  it("closes only the erroring subagent's lane", async () => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("B", "s2", "m2"),
      { type: EventType.SUBAGENT_ERROR, subagentRunId: "s1", message: "boom" },
      textChunk("C", "s2"),
      RUN_FINISHED,
    );

    const ends = shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END);
    expect(ends).toEqual([
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_END, "m2", "", "s2"],
    ]);
    // s2's continuation survived its sibling's failure.
    expect(shape(events)).toContainEqual([EventType.TEXT_MESSAGE_CONTENT, "m2", "C", "s2"]);
  });

  it("does not close the parent's lane on a terminal that names no subagent", async () => {
    // Malformed input: the id is required. It must not be read as "the parent lane".
    const events = await run(
      textChunk("A", undefined, "p1"),
      { type: EventType.SUBAGENT_FINISHED },
      textChunk("B"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "A", null],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "B", null],
    ]);
  });

  it("emits just the terminal when the finishing subagent has nothing open", async () => {
    const events = await run({ type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" });
    expect(shape(events)).toEqual([[EventType.SUBAGENT_FINISHED, "", "", "s1"]]);
  });

  it("closes every open lane at RUN_FINISHED, in the order they opened", async () => {
    const events = await run(
      textChunk("A", "s2", "m2"),
      textChunk("B", undefined, "p1"),
      textChunk("C", "s1", "m1"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END)).toEqual([
      [EventType.TEXT_MESSAGE_END, "m2", "", "s2"],
      [EventType.TEXT_MESSAGE_END, "p1", "", null],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
    ]);
    expect(shape(events).at(-1)?.[0]).toBe(EventType.RUN_FINISHED);
  });

  it("closes every open lane at RUN_ERROR", async () => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("B", "s2", "m2"),
      { type: EventType.RUN_ERROR, message: "boom" },
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END)).toHaveLength(2);
    expect(shape(events).at(-1)?.[0]).toBe(EventType.RUN_ERROR);
  });

  it("closes every open lane at MESSAGES_SNAPSHOT", async () => {
    // The snapshot restates the whole conversation, so no lane may still be mid-assembly.
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("B", "s2", "m2"),
      { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END)).toHaveLength(2);
    expect(shape(events).at(-1)?.[0]).toBe(EventType.MESSAGES_SNAPSHOT);
  });

  it("does not let the parent's explicit message close a subagent's chunk stream", async () => {
    // An explicit event closes only its OWN lane. Closing the single global stream meant
    // a parent's TEXT_MESSAGE_START ended a subagent's half-assembled message.
    const events = await run(
      textChunk("A", "s1", "m1"),
      { type: EventType.TEXT_MESSAGE_START, messageId: "p1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "p1" },
      textChunk("B", "s1"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", "s1"],
    ]);
    // Exactly one synthesized END, for m1, after the parent's explicit pair.
    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END)).toEqual([
      [EventType.TEXT_MESSAGE_END, "p1", "", null],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
    ]);
  });

  it("does close a subagent's chunk stream on that subagent's own explicit message", async () => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      { type: EventType.TEXT_MESSAGE_START, messageId: "x1", role: "assistant", subagentRunId: "s1" },
      RUN_FINISHED,
    );

    expect(shape(events)).toEqual([
      [EventType.TEXT_MESSAGE_START, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_START, "x1", "", "s1"],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });

  it("does not let a subagent's step event close the parent's chunk stream", async () => {
    const events = await run(
      textChunk("A", undefined, "p1"),
      { type: EventType.STEP_STARTED, stepName: "work", subagentRunId: "s1" },
      textChunk("B"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "A", null],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "B", null],
    ]);
  });

  it("closes every open lane at a second RUN_STARTED, in the order they opened", async () => {
    // RUN_STARTED is a run-level event like RUN_FINISHED: a lane from the previous run
    // must not survive into the next one, where its id means nothing.
    const events = await run(
      RUN_STARTED,
      textChunk("A", "s2", "m2"),
      textChunk("B", undefined, "p1"),
      textChunk("C", "s1", "m1"),
      RUN_STARTED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END)).toEqual([
      [EventType.TEXT_MESSAGE_END, "m2", "", "s2"],
      [EventType.TEXT_MESSAGE_END, "p1", "", null],
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
    ]);
    expect(shape(events).at(-1)?.[0]).toBe(EventType.RUN_STARTED);
  });

  // The pass-through set: these events are emitted untouched, so they must leave every
  // lane alone even when they carry a subagent's tag. A lane is proven still open by its
  // next continuation landing on the same entity, and by no END appearing before the run
  // terminal.
  const passThroughEvents: [string, unknown][] = [
    [
      EventType.SUBAGENT_STARTED,
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" },
    ],
    [
      EventType.REASONING_ENCRYPTED_VALUE,
      {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: "m1",
        encryptedValue: "opaque",
        subagentRunId: "s1",
      },
    ],
    [
      EventType.ACTIVITY_SNAPSHOT,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "a1",
        activityType: "search",
        content: {},
        subagentRunId: "s1",
      },
    ],
    [
      EventType.ACTIVITY_DELTA,
      { type: EventType.ACTIVITY_DELTA, messageId: "a1", delta: [], subagentRunId: "s1" },
    ],
    [EventType.RAW, { type: EventType.RAW, event: {}, subagentRunId: "s1" }],
  ];

  it.each(passThroughEvents)("does not close any lane on %s", async (_type, passThrough) => {
    const events = await run(
      textChunk("A", "s1", "m1"),
      textChunk("P", undefined, "p1"),
      passThrough,
      textChunk("B", "s1"),
      textChunk("Q"),
      RUN_FINISHED,
    );

    expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "P", null],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", "s1"],
      [EventType.TEXT_MESSAGE_CONTENT, "p1", "Q", null],
    ]);
    // Both lanes closed by the run terminal, not by the pass-through event.
    expect(shape(events).slice(-3)).toEqual([
      [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      [EventType.TEXT_MESSAGE_END, "p1", "", null],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });

  // These two DO close their own lane, and an untagged one names the parent lane — so
  // they must not reach across into a subagent's.
  const untaggedOwnLaneClosers: [string, unknown][] = [
    [
      EventType.TOOL_CALL_RESULT,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tr1",
        toolCallId: "c9",
        content: "{}",
        role: "tool",
      },
    ],
    [EventType.STEP_FINISHED, { type: EventType.STEP_FINISHED, stepName: "work" }],
  ];

  it.each(untaggedOwnLaneClosers)(
    "does not close a subagent's lane on an untagged %s",
    async (_type, closer) => {
      const events = await run(
        textChunk("A", "s1", "m1"),
        closer,
        textChunk("B", "s1"),
        RUN_FINISHED,
      );

      expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_CONTENT)).toEqual([
        [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", "s1"],
        [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", "s1"],
      ]);
      expect(shape(events).filter((e) => e[0] === EventType.TEXT_MESSAGE_END)).toEqual([
        [EventType.TEXT_MESSAGE_END, "m1", "", "s1"],
      ]);
    },
  );
});

describe("transformChunks lanes: unattributed runs are unaffected", () => {
  it("behaves exactly as a single pending stream when nothing is attributed", async () => {
    // The safety property for every existing producer: with no tags anywhere, only the
    // parent lane is ever used, so the old semantics apply verbatim — including one
    // family at a time.
    const events = await run(
      textChunk("A", undefined, "m1"),
      textChunk("B"),
      toolChunk("{", undefined, "c1"),
      textChunk("C", undefined, "m2"),
      RUN_FINISHED,
    );

    expect(shape(events)).toEqual([
      [EventType.TEXT_MESSAGE_START, "m1", "", null],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "A", null],
      [EventType.TEXT_MESSAGE_CONTENT, "m1", "B", null],
      [EventType.TEXT_MESSAGE_END, "m1", "", null],
      [EventType.TOOL_CALL_START, "c1", "", null],
      [EventType.TOOL_CALL_ARGS, "c1", "{", null],
      [EventType.TOOL_CALL_END, "c1", "", null],
      [EventType.TEXT_MESSAGE_START, "m2", "", null],
      [EventType.TEXT_MESSAGE_CONTENT, "m2", "C", null],
      [EventType.TEXT_MESSAGE_END, "m2", "", null],
      [EventType.RUN_FINISHED, "", "", null],
    ]);
  });
});

describe("transformChunks lanes: the output is a valid stream", () => {
  /** The transform runs upstream of the verifier, so its output has to satisfy it. */
  const runVerified = (...events: unknown[]) =>
    firstValueFrom(
      transformChunks(false)(from(events as BaseEvent[]))
        .pipe(verifyEvents(false))
        .pipe(toArray()),
    );

  it("accepts interleaved subagents declared with lifecycle events", async () => {
    await expect(
      runVerified(
        RUN_STARTED,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" },
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" },
        textChunk("A", "s1", "m1"),
        textChunk("B", "s2", "m2"),
        textChunk("C", "s1"),
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" },
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s2" },
        RUN_FINISHED,
      ),
    ).resolves.toBeDefined();
  });

  it("accepts interleaved subagents in attribution-only mode", async () => {
    // Phase 1 attribution is valid without any lifecycle events, so the synthesized
    // boundaries must be valid without them too.
    await expect(
      runVerified(
        RUN_STARTED,
        textChunk("A", "s1", "m1"),
        textChunk("B", "s2", "m2"),
        textChunk("C", "s1"),
        RUN_FINISHED,
      ),
    ).resolves.toBeDefined();
  });

  it("accepts a parent and a subagent streaming different families at once", async () => {
    await expect(
      runVerified(
        RUN_STARTED,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" },
        textChunk("P", undefined, "p1"),
        toolChunk("{", "s1", "c1"),
        textChunk("Q"),
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" },
        RUN_FINISHED,
      ),
    ).resolves.toBeDefined();
  });

  // Only the text family was checked against the verifier. The tool and reasoning
  // families synthesize their own boundaries and carry their own attribution, so each
  // needs the same round trip.
  it("accepts interleaved subagents' tool calls", async () => {
    await expect(
      runVerified(
        RUN_STARTED,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" },
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" },
        toolChunk('{"a', "s1", "c1"),
        toolChunk('{"b', "s2", "c2"),
        toolChunk('":1}', "s1"),
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" },
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s2" },
        RUN_FINISHED,
      ),
    ).resolves.toBeDefined();
  });

  it("accepts interleaved subagents' reasoning messages", async () => {
    await expect(
      runVerified(
        RUN_STARTED,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" },
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s2", name: "b" },
        reasoningChunk("A", "s1", "r1"),
        reasoningChunk("B", "s2", "r2"),
        reasoningChunk("C", "s1"),
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" },
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s2" },
        RUN_FINISHED,
      ),
    ).resolves.toBeDefined();
  });

  it("accepts a two-run stream whose lanes are reopened in the second run", async () => {
    // Ids are per-run, so run 2 legitimately reuses m1 and s1 after run 1 closed them.
    await expect(
      runVerified(
        RUN_STARTED,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" },
        textChunk("A", "s1", "m1"),
        textChunk("P", undefined, "p1"),
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" },
        RUN_FINISHED,
        RUN_STARTED,
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "s1", name: "a" },
        textChunk("B", "s1", "m1"),
        textChunk("Q", undefined, "p1"),
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "s1" },
        RUN_FINISHED,
      ),
    ).resolves.toBeDefined();
  });
});
