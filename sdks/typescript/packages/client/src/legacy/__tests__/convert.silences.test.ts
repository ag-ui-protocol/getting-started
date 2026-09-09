/**
 * Three places where the legacy bridge lost something without saying so.
 *
 * The bridge is a translation to a protocol that cannot represent everything
 * AG-UI can, so losing material is expected — losing it silently is not, and
 * a downstream reader of the legacy stream has no way to tell an absence from
 * a translation that never happened.
 */
import { convertToLegacyEvents } from "../convert";
import { of } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  BaseEvent,
  EventType,
  StateDeltaEvent,
  StateSnapshotEvent,
  ToolCallArgsEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { LegacyRuntimeProtocolEvent } from "../types";

async function bridge(events: BaseEvent[]): Promise<{
  legacy: LegacyRuntimeProtocolEvent[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  try {
    const legacy = await firstValueFrom(
      convertToLegacyEvents("t1", "r1", "agent")(of(...events)).pipe(toArray()),
    );
    return { legacy, warnings };
  } finally {
    warn.mockRestore();
  }
}

// The bridge's warnings gate on SUPPRESS_TRANSFORMATION_WARNINGS like every
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

describe("the legacy bridge says what it loses", () => {
  it("survives a STATE_DELTA that cannot be applied, and warns", async () => {
    // `applyPatch(..., validate = true)` THROWS on a bad patch, so the
    // `if (!result) return []` that stood here was dead code and one
    // malformed delta tore the whole bridge down. The reducer in apply/
    // already catches and warns; this now matches it.
    const { legacy, warnings } = await bridge([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { a: 1 },
      } as StateSnapshotEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/nothing/here", value: 2 }],
      } as StateDeltaEvent,
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { a: 2 },
      } as StateSnapshotEvent,
    ]);

    // The stream carried on: the snapshot after the bad delta still arrived.
    expect(legacy).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(/state patch/i);
  });

  it("warns when a tool result names a call it never saw start", async () => {
    // "unknown" is a fabricated action name that downstream consumers route
    // on. Inventing it in silence is the expensive half.
    const { legacy, warnings } = await bridge([
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m1",
        toolCallId: "call-never-started",
        content: "42",
      } as ToolCallResultEvent,
    ]);

    expect(legacy).toHaveLength(1);
    expect(warnings.join("\n")).toContain("call-never-started");
    expect(warnings.join("\n")).toContain("unknown");
  });

  it("warns when a RAW event is dropped", async () => {
    const { legacy, warnings } = await bridge([
      { type: EventType.RAW, event: { provider: "payload" } } as BaseEvent,
    ]);

    expect(legacy).toHaveLength(0);
    expect(warnings.join("\n")).toContain("RAW");
  });
});

describe("the bridge's warnings behave like every other transformation warning", () => {
  it("warns ONCE per stream about dropped RAW events, however many arrive", async () => {
    // Providers emit RAW per streamed chunk, so a warning per event turns one
    // lossy translation into thousands of identical console lines. The loss is
    // a property of the bridge, not of any one event: saying it once says it.
    const { legacy, warnings } = await bridge([
      { type: EventType.RAW, event: { chunk: 1 } } as BaseEvent,
      { type: EventType.RAW, event: { chunk: 2 } } as BaseEvent,
      { type: EventType.RAW, event: { chunk: 3 } } as BaseEvent,
    ]);

    expect(legacy).toHaveLength(0);
    expect(warnings.filter((line) => line.includes("RAW"))).toHaveLength(1);
  });

  it("counts per stream, not per process", async () => {
    // The flag lives in the per-stream closure, so a second bridge over a
    // second stream still reports its own loss.
    const first = await bridge([{ type: EventType.RAW, event: {} } as BaseEvent]);
    const second = await bridge([{ type: EventType.RAW, event: {} } as BaseEvent]);
    expect(first.warnings.filter((line) => line.includes("RAW"))).toHaveLength(1);
    expect(second.warnings.filter((line) => line.includes("RAW"))).toHaveLength(1);
  });

  it("says nothing at all when SUPPRESS_TRANSFORMATION_WARNINGS is set", async () => {
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = "true";
    const { warnings } = await bridge([
      { type: EventType.RAW, event: {} } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m1",
        toolCallId: "call-never-started",
        content: "42",
      } as ToolCallResultEvent,
      { type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 } } as StateSnapshotEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/nothing/here", value: 2 }],
      } as StateDeltaEvent,
    ]);

    expect(warnings).toEqual([]);
  });
});

describe("an EMPTY tool call name is as unroutable as a missing one", () => {
  // `toolCallName` is `z.string()`, so "" is a conformant value a producer may
  // send — and the legacy protocol routes on the action name, where "" names
  // nothing. The guard used to be `||`, which mapped "" to the fabricated
  // "unknown" along with `undefined`; tightening it to `??` quietly changed
  // that to bridging `actionName: ""` with no warning at all, which is the
  // silent loss this file exists to rule out.
  const openedEmpty: BaseEvent[] = [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: "",
      parentMessageId: "m1",
    } as ToolCallStartEvent,
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m2",
      toolCallId: "call-1",
      content: "42",
    } as ToolCallResultEvent,
  ];

  it("bridges it as \"unknown\", not as the empty string", async () => {
    const { legacy } = await bridge(openedEmpty);
    const result = legacy.find((entry) => entry.type === "ActionExecutionResult")!;
    expect((result as { actionName?: string }).actionName).toBe("unknown");
  });

  it("says so, exactly as it does for a name it never saw", async () => {
    const { warnings } = await bridge(openedEmpty);
    expect(warnings.join("\n")).toContain("call-1");
    expect(warnings.join("\n")).toContain("unknown");
  });

  it("still bridges a real name unchanged, and silently", async () => {
    // The control: tightening the guard must not start warning about the
    // ordinary case.
    const { legacy, warnings } = await bridge([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-2",
        toolCallName: "search",
        parentMessageId: "m1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m2",
        toolCallId: "call-2",
        content: "42",
      } as ToolCallResultEvent,
    ]);
    const result = legacy.find((entry) => entry.type === "ActionExecutionResult")!;
    expect((result as { actionName?: string }).actionName).toBe("search");
    expect(warnings).toEqual([]);
  });
});

describe("the TOOL_CALL_ARGS orphan warning", () => {
  const orphanArgs: BaseEvent[] = [
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "never-opened", delta: "{}" } as ToolCallArgsEvent,
  ];

  it("names the tool call it could not find", async () => {
    const { legacy, warnings } = await bridge(orphanArgs);
    expect(legacy).toHaveLength(0);
    expect(warnings.join("\n")).toContain("never-opened");
  });

  it("is silenced by SUPPRESS_TRANSFORMATION_WARNINGS like the rest of the bridge", async () => {
    // TOOL_CALL_ARGS is the per-chunk hot path the gate's own justification
    // names: one line per streamed token of a tool call's arguments, and no
    // way to turn it off, is a reason to patch the library out rather than to
    // set the flag.
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = "true";
    const { warnings } = await bridge(orphanArgs);
    expect(warnings).toEqual([]);
  });
});
