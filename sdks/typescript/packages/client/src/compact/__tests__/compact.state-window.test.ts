/**
 * Compacting a window of state events that contains no SNAPSHOT.
 *
 * Collapsing `SNAPSHOT + deltas` into one snapshot is sound: the snapshot said
 * what the whole state was, and the deltas are applied on top of it. Deltas
 * ALONE are different — they are relative to a state this window never saw, so
 * seeding an empty object and calling the result a snapshot manufactures an
 * authoritative statement that everything else was absent. Replaying that
 * wipes whatever the consumer already held.
 */
import { compactEvents } from "../compact";
import { BaseEvent, EventType, StateDeltaEvent, StateSnapshotEvent } from "@ag-ui/core";

const RUN_STARTED = {
  type: EventType.RUN_STARTED,
  threadId: "t",
  runId: "r",
} as BaseEvent;
const RUN_FINISHED = {
  type: EventType.RUN_FINISHED,
  threadId: "t",
  runId: "r",
} as BaseEvent;

// The compaction warnings gate on SUPPRESS_TRANSFORMATION_WARNINGS like every
// other transformation warning in the package, so the tests that assert on one
// have to run with the flag off whatever the surrounding environment sets.
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

describe("compacting a state window with no snapshot in it", () => {
  it("keeps the deltas as deltas rather than manufacturing a snapshot", async () => {
    const events: BaseEvent[] = [
      RUN_STARTED,
      { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/added", value: 1 }] } as StateDeltaEvent,
      { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/also", value: 2 }] } as StateDeltaEvent,
      RUN_FINISHED,
    ];

    const compacted = compactEvents(events);

    expect(compacted.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_DELTA,
      EventType.STATE_DELTA,
      EventType.RUN_FINISHED,
    ]);
    // And they still say what they said.
    expect((compacted[1] as StateDeltaEvent).delta).toEqual([
      { op: "add", path: "/added", value: 1 },
    ]);
    expect((compacted[2] as StateDeltaEvent).delta).toEqual([
      { op: "add", path: "/also", value: 2 },
    ]);
  });

  it("still collapses a window that DOES open with a snapshot", async () => {
    const events: BaseEvent[] = [
      RUN_STARTED,
      { type: EventType.STATE_SNAPSHOT, snapshot: { kept: true } } as StateSnapshotEvent,
      { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/added", value: 1 }] } as StateDeltaEvent,
      RUN_FINISHED,
    ];

    const compacted = compactEvents(events);

    expect(compacted.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ kept: true, added: 1 });
  });

  it("folds from the LAST snapshot in the window, not from the start of it", async () => {
    // A delta that arrives BEFORE the snapshot is unobservable by definition:
    // the snapshot restates the whole document, so nothing the delta did to
    // the state can survive it. Folding it anyway meant applying it to the
    // seeded `{}`, where its path does not resolve — `applyPatch` validates,
    // so it THREW, and the catch below warned about a patch that had not
    // failed and whose failure changed nothing. The result was right and the
    // diagnosis was wrong, which is the worse of the two.
    const warnings: string[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
    let compacted: BaseEvent[];
    try {
      compacted = compactEvents([
        RUN_STARTED,
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/a", value: 1 }],
        } as StateDeltaEvent,
        { type: EventType.STATE_SNAPSHOT, snapshot: { b: 2 } } as StateSnapshotEvent,
        { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/c", value: 3 }] } as StateDeltaEvent,
        RUN_FINISHED,
      ]);
    } finally {
      warn.mockRestore();
    }

    expect(compacted.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ b: 2, c: 3 });
    expect(warnings).toEqual([]);
  });

  it("survives a delta that cannot be applied to the snapshot before it", async () => {
    // applyPatch validates, and so throws. Uncaught, one malformed delta took
    // down every consumer that compacts a stream.
    const warnings: string[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
    let compacted: BaseEvent[];
    try {
      compacted = compactEvents([
        RUN_STARTED,
        { type: EventType.STATE_SNAPSHOT, snapshot: { kept: true } } as StateSnapshotEvent,
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/nothing/here", value: 1 }],
        } as StateDeltaEvent,
        RUN_FINISHED,
      ]);
    } finally {
      warn.mockRestore();
    }

    expect(compacted.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    // What could be applied is kept; the failure is announced.
    expect((compacted[1] as StateSnapshotEvent).snapshot).toEqual({ kept: true });
    expect(warnings.join("\n")).toMatch(/state patch/i);
  });
});

describe("the compaction warning behaves like every other transformation warning", () => {
  it("says nothing when SUPPRESS_TRANSFORMATION_WARNINGS is set", async () => {
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = "true";
    const warnings: string[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
    try {
      compactEvents([
        RUN_STARTED,
        { type: EventType.STATE_SNAPSHOT, snapshot: { kept: true } } as StateSnapshotEvent,
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/nothing/here", value: 1 }],
        } as StateDeltaEvent,
        RUN_FINISHED,
      ]);
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toEqual([]);
  });
});
