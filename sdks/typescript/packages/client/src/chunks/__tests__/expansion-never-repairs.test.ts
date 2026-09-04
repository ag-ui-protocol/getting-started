/**
 * Chunk expansion must RESHAPE, never repair.
 *
 * There are two places it runs, and they sit on opposite sides of the
 * enforcement stage:
 *
 * - With no middleware installed, the agent pipeline is `enforce -> expand`,
 *   so the chunk itself is validated and expansion only ever sees good values.
 * - With a middleware installed, `Middleware.runNext` expands INSIDE the
 *   chain, upstream of enforcement — middleware must see whole events, never
 *   chunks — so expansion is handed raw producer output and whatever it
 *   synthesises is what enforcement later judges.
 *
 * Anything expansion cannot vouch for therefore has to ride through onto the
 * synthesized events. Repairing it makes the same producer defect fatal on one
 * path and invisible on the other, which is exactly the divergence these tests
 * pin: every case below asserts the SAME outcome with and without a shim.
 */
import { Observable, of } from "rxjs";
import { HttpAgent } from "@/agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";

/** Replays a scripted stream in place of a real request. */
function scripted(stream: Record<string, unknown>[], pinned?: string) {
  class ScriptedHttpAgent extends HttpAgent {
    override get maxProtocolVersion(): string {
      return pinned ?? super.maxProtocolVersion;
    }
    override run(_input: RunAgentInput): Observable<BaseEvent> {
      return of(...(stream as unknown as BaseEvent[]));
    }
  }
  return new ScriptedHttpAgent({ url: "http://x.test/agent" });
}

/**
 * Both sides of the enforcement boundary. "0.0.45" installs three era shims,
 * every one of which reaches the next agent through `runNext` — so expansion
 * happens inside the chain. Unpinned installs only the compatibility boundary,
 * which deliberately does NOT expand.
 */
const PATHS: Array<[label: string, pinned: string | undefined]> = [
  ["with no shim installed (expansion after enforcement)", undefined],
  ["pinned at 0.0.45 (expansion inside the middleware chain)", "0.0.45"],
];

interface RunOutcome {
  failed: boolean;
  error?: string;
  warnings: string[];
  eventTypes: string[];
  /** The events as APPLICATION CODE received them, payloads included. */
  events: BaseEvent[];
}

async function replay(
  stream: Record<string, unknown>[],
  pinned: string | undefined,
): Promise<RunOutcome> {
  const agent = scripted(stream, pinned);
  const eventTypes: string[] = [];
  const events: BaseEvent[] = [];
  agent.subscribe({
    onEvent: ({ event }) => {
      eventTypes.push(String((event as { type?: unknown }).type));
      events.push(event);
    },
  });
  const warnings: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await agent.runAgent({ runId: "chunk-run" });
    return { failed: false, warnings, eventTypes, events };
  } catch (error) {
    return { failed: true, error: (error as Error).message, warnings, eventTypes, events };
  } finally {
    warn.mockRestore();
    errorLog.mockRestore();
  }
}

// Every case here asserts on a warning, and those gate on
// SUPPRESS_TRANSFORMATION_WARNINGS. Cleared for the duration and PUT BACK, so
// the suite neither depends on the ambient environment nor changes it for
// whatever vitest runs next in this worker.
let priorSuppress: string | undefined;
beforeEach(() => {
  priorSuppress = process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
});
afterEach(() => {
  if (priorSuppress === undefined) {
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  } else {
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = priorSuppress;
  }
});

const STARTED = { type: EventType.RUN_STARTED, threadId: "t", runId: "chunk-run" };
const FINISHED = { type: EventType.RUN_FINISHED, threadId: "t", runId: "chunk-run" };

describe.each(PATHS)("a chunk carrying a null delta, %s", (_label, pinned) => {
  it.each([
    ["TEXT_MESSAGE_CHUNK", { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: null }],
    [
      "TOOL_CALL_CHUNK",
      { type: "TOOL_CALL_CHUNK", toolCallId: "tc1", toolCallName: "search", delta: null },
    ],
    [
      "REASONING_MESSAGE_CHUNK",
      { type: "REASONING_MESSAGE_CHUNK", messageId: "rm1", delta: null },
    ],
  ])("fails the run (%s)", async (_type, chunk) => {
    // `delta: null` is a known field holding a value the schema rejects.
    // `?? ""` read it as absence and substituted the empty string, so behind a
    // shim the run happily delivered a zero-length content event.
    const result = await replay([STARTED, chunk, FINISHED], pinned);
    expect(result.failed, `expected a failure, saw ${result.eventTypes.join(", ")}`).toBe(true);
    // Named, not merely counted. "the run failed" is satisfied by any defect
    // anywhere in the fixture, so it would still pass if `delta` were quietly
    // repaired and something unrelated blew up instead. The validator reports
    // the offending path, so the rejection has to be about THIS field and
    // about the value the rule forbids.
    expect(result.error).toContain('"delta"');
    expect(result.error).toContain("received null");
  });
});

describe.each(PATHS)("a chunk carrying an unrecognised property, %s", (_label, pinned) => {
  it("is stripped with a warning naming it", async () => {
    // Expansion builds the synthesized events field by field, so anything it
    // does not know about was silently dropped before enforcement could say a
    // word — the guarantee is that nothing is dropped without a warning.
    const result = await replay(
      [
        STARTED,
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", role: "assistant", delta: "hi" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "!", futureField: "from 1.1" },
        FINISHED,
      ],
      pinned,
    );

    expect(result.failed, result.error).toBe(false);
    expect(result.warnings.join("\n")).toContain("futureField");
  });

  it("is warned about even on a chunk that synthesises nothing else", async () => {
    // A continuation carrying ONLY unrecognised material used to expand into
    // no event at all, so there was nothing left for enforcement to strip and
    // warn about.
    const result = await replay(
      [
        STARTED,
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", role: "assistant", delta: "hi" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", futureField: "from 1.1" },
        FINISHED,
      ],
      pinned,
    );

    expect(result.failed, result.error).toBe(false);
    expect(result.warnings.join("\n")).toContain("futureField");
  });

  it("does not let the unrecognised material reach application code", async () => {
    // The remainder rides onto the CONTENT event precisely so enforcement can
    // find it. The other half of that bargain is that enforcement then REMOVES
    // it: a subscriber must never be handed a property this build cannot
    // describe. Asserting only that a CONTENT event arrived says nothing about
    // its payload, which is the whole subject of the test.
    const result = await replay(
      [
        STARTED,
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", role: "assistant", delta: "hi" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "!", futureField: "from 1.1" },
        FINISHED,
      ],
      pinned,
    );
    expect(result.failed, result.error).toBe(false);

    const contents = result.events.filter(
      (event) => event.type === EventType.TEXT_MESSAGE_CONTENT,
    ) as Array<Record<string, unknown>>;
    expect(contents.map((event) => event.delta)).toEqual(["hi", "!"]);
    for (const event of contents) {
      expect(Object.keys(event)).not.toContain("futureField");
    }
    // Nothing reached application code, and nothing went silently: both halves
    // of the guarantee, asserted together.
    expect(result.warnings.join("\n")).toContain("futureField");
  });
});

describe.each(PATHS)("an OPENING chunk carrying an unrecognised property, %s", (_label, pinned) => {
  // The opener is the case the fallback above cannot reach. A first chunk
  // pushes its synthesized `*_START` before anything else, so the
  // "synthesised nothing" fallback — guarded on an empty result — can never
  // fire for it; and with no `delta` and no `rawEvent` there is no content
  // event to carry the remainder either. The property vanished in silence on
  // the shimmed path, which is precisely what "nothing is dropped without a
  // warning" forbids. All three arms have the same shape, so all three are
  // pinned here.
  it.each([
    [
      "TEXT_MESSAGE_CHUNK",
      [{ type: "TEXT_MESSAGE_CHUNK", messageId: "m1", role: "assistant", futureField: "from 1.1" }],
      EventType.TEXT_MESSAGE_START,
    ],
    [
      "TOOL_CALL_CHUNK",
      [
        {
          type: "TOOL_CALL_CHUNK",
          toolCallId: "tc1",
          toolCallName: "search",
          futureField: "from 1.1",
        },
      ],
      EventType.TOOL_CALL_START,
    ],
    [
      "REASONING_MESSAGE_CHUNK",
      [
        { type: "REASONING_START", messageId: "rm1" },
        { type: "REASONING_MESSAGE_CHUNK", messageId: "rm1", futureField: "from 1.1" },
        { type: "REASONING_END", messageId: "rm1" },
      ],
      EventType.REASONING_MESSAGE_START,
    ],
  ])("is warned about rather than dropped in silence (%s)", async (_type, chunks, opener) => {
    const result = await replay([STARTED, ...chunks, FINISHED], pinned);

    expect(result.failed, result.error).toBe(false);
    expect(result.eventTypes).toContain(opener);
    expect(result.warnings.join("\n")).toContain("futureField");
  });

  it("announces a remainder key the synthesized opener itself declares", async () => {
    // The remainder rides onto the opener spread-FIRST, so a described field
    // can never be shadowed by a producer's value of the same name. That is
    // right, and it has a cost the guarantee has to cover: when the opener
    // DECLARES the colliding key, the opener's value wins and the producer's
    // is overwritten before enforcement ever sees it — dropped in silence,
    // which is the one thing this stage promises not to do.
    //
    // Reachable on exactly one arm today. REASONING_MESSAGE_START declares
    // `role` (this stage sets it to "reasoning"); REASONING_MESSAGE_CHUNK does
    // not declare `role` at all, so a producer's `role` on the chunk is
    // remainder and collides. The text and tool arms are safe — their START
    // keys are a subset of their chunk's.
    const result = await replay(
      [
        STARTED,
        { type: "REASONING_START", messageId: "rm1" },
        { type: "REASONING_MESSAGE_CHUNK", messageId: "rm1", role: "wizard" },
        { type: "REASONING_END", messageId: "rm1" },
        FINISHED,
      ],
      pinned,
    );

    expect(result.failed, result.error).toBe(false);
    expect(result.warnings.join("\n")).toContain("role");

    // And the opener's own value still wins: overwriting it with the
    // producer's would make the same stream fatal behind a shim and fine
    // without one, which is the divergence this whole file exists to prevent.
    const opener = result.events.find(
      (event) => event.type === EventType.REASONING_MESSAGE_START,
    ) as Record<string, unknown> | undefined;
    expect(opener?.role).toBe("reasoning");
  });

  it("does not claim a collision for a key that only Object.prototype has", async () => {
    // The collision report has to describe what the spread actually did, and
    // the spread copies OWN enumerable properties. A producer key that merely
    // shares a name with something on Object.prototype is NOT shadowed — it
    // survives onto the opener and is stripped by enforcement like any other
    // remainder — so reporting it as dropped would be a false statement in a
    // warning.
    const result = await replay(
      [
        STARTED,
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", role: "assistant", toString: "shadow?" },
        FINISHED,
      ],
      pinned,
    );

    expect(result.failed, result.error).toBe(false);
    expect(result.warnings.join("\n")).not.toContain("already describes");
    // It went the ordinary way instead: carried, then stripped and named.
    expect(result.warnings.join("\n")).toContain("toString");
  });
});
