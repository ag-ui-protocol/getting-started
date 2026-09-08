import { describe, it, expect } from "vitest";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";
import { A2UIMiddleware, A2UIActivityType } from "../src/index";
import { AbstractAgent } from "@ag-ui/client";

// Minimal mock agent that replays a fixed event sequence.
class MockAgent extends AbstractAgent {
  constructor(private events: BaseEvent[]) {
    super();
  }
  run(): Observable<BaseEvent> {
    return new Observable((s) => {
      for (const e of this.events) s.next(e);
      s.complete();
    });
  }
}

function input(): RunAgentInput {
  return { threadId: "t", runId: "r", tools: [], context: [], forwardedProps: {}, state: {}, messages: [] };
}
const collect = (o: Observable<BaseEvent>) => firstValueFrom(o.pipe(toArray()));

// Inline JSON-Schema catalog (A2UIInlineCatalogSchema): Row requires children;
// HotelCard requires name + rating.
const CATALOG = {
  catalogId: "https://a2ui.org/demos/dojo/dynamic_catalog.json",
  components: {
    Row: { type: "object", required: ["children"] },
    HotelCard: { type: "object", required: ["name", "rating"] },
  },
};

const ROOT = { id: "root", component: "Row", children: { componentId: "card", path: "/items" } };
const GOOD_CARD = { id: "card", component: "HotelCard", name: { path: "name" }, rating: { path: "rating" } };
const BAD_CARD = { id: "card", component: "HotelCard", name: { path: "name" } }; // missing required `rating`
const DATA = { items: [{ name: "Ritz", rating: 4.8 }] };

function streamRender(components: unknown[]) {
  const args = JSON.stringify({ surfaceId: "hotels", components, data: DATA });
  return [
    { type: EventType.RUN_STARTED, runId: "r", threadId: "t" },
    { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "render_a2ui" },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: args },
    { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
    { type: EventType.RUN_FINISHED, runId: "r", threadId: "t" },
  ] as BaseEvent[];
}

// The A2UI generation lifecycle now rides ONE `a2ui-surface` activity (OSS-162):
// pre-paint snapshots carry a `status`; the painted surface carries `a2ui_operations`.
const surfaceSnapshots = (events: BaseEvent[]) =>
  events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT && (e as any).activityType === A2UIActivityType);
const paints = (events: BaseEvent[]) =>
  surfaceSnapshots(events).filter((e) => Array.isArray((e as any).content?.a2ui_operations));
const lifecycle = (events: BaseEvent[]) =>
  surfaceSnapshots(events).filter((e) => typeof (e as any).content?.status === "string");
const withStatus = (events: BaseEvent[], status: string) =>
  lifecycle(events).filter((e) => (e as any).content.status === status);

describe("A2UI middleware — unified generation lifecycle gate (OSS-162)", () => {
  it("suppresses a semantically-invalid streamed component tree (no faulty paint)", async () => {
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const events = await collect(mw.run(input(), new MockAgent(streamRender([ROOT, BAD_CARD]))));
    // No surface painted for the invalid attempt...
    expect(paints(events)).toHaveLength(0);
    // ...and a "retrying" lifecycle status is surfaced on the surface activity.
    expect(withStatus(events, "retrying").length).toBeGreaterThanOrEqual(1);
  });

  it("emits a surface for a valid streamed tree (existing behavior preserved)", async () => {
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const events = await collect(mw.run(input(), new MockAgent(streamRender([ROOT, GOOD_CARD]))));
    const p = paints(events);
    expect(p.length).toBeGreaterThanOrEqual(1);
    expect((p[0] as any).content.a2ui_operations.length).toBeGreaterThanOrEqual(2);
    // A valid tree never retries.
    expect(withStatus(events, "retrying")).toHaveLength(0);
  });

  it("emits a 'building' skeleton when generation starts, sharing the paint's messageId", async () => {
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const events = await collect(mw.run(input(), new MockAgent(streamRender([ROOT, GOOD_CARD]))));
    const building = withStatus(events, "building");
    expect(building.length).toBeGreaterThanOrEqual(1);
    // In-place: the building skeleton and the painted surface share one messageId,
    // so the surface replaces the skeleton rather than stacking beneath it.
    const buildingId = (building[0] as any).messageId;
    expect(paints(events).some((e) => (e as any).messageId === buildingId)).toBe(true);
  });

  it("does NOT over-suppress when no catalog is configured (structural-only)", async () => {
    // No `schema` → catalog checks skipped; an unknown component type still paints.
    const mw = new A2UIMiddleware();
    const unknown = [{ id: "root", component: "MysteryCard", children: { componentId: "card", path: "/items" } }, { id: "card", component: "MysteryCard", name: { path: "name" } }];
    const events = await collect(mw.run(input(), new MockAgent(streamRender(unknown))));
    expect(paints(events).length).toBeGreaterThanOrEqual(1);
  });

  it("a valid later attempt replaces the retrying skeleton in place (same messageId)", async () => {
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const badArgs = JSON.stringify({ surfaceId: "hotels", components: [ROOT, BAD_CARD], data: DATA });
    const goodArgs = JSON.stringify({ surfaceId: "hotels", components: [ROOT, GOOD_CARD], data: DATA });
    const events = await collect(
      mw.run(
        input(),
        new MockAgent([
          { type: EventType.RUN_STARTED, runId: "r", threadId: "t" },
          // Outer generate_a2ui wraps two inner render_a2ui attempts.
          { type: EventType.TOOL_CALL_START, toolCallId: "outer1", toolCallName: "generate_a2ui" },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: "outer1", delta: '{"intent":"create"}' },
          { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "render_a2ui" },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: badArgs },
          { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
          { type: EventType.TOOL_CALL_START, toolCallId: "tc2", toolCallName: "render_a2ui" },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc2", delta: goodArgs },
          { type: EventType.TOOL_CALL_END, toolCallId: "tc2" },
          { type: EventType.RUN_FINISHED, runId: "r", threadId: "t" },
        ] as BaseEvent[]),
      ),
    );
    const retrying = withStatus(events, "retrying");
    expect(retrying.length).toBeGreaterThanOrEqual(1);
    const painted = paints(events);
    expect(painted.length).toBeGreaterThanOrEqual(1);
    // In-place replacement: the retrying skeleton and the painted surface share the
    // one outer-call messageId (no leftover skeleton beneath the surface).
    const retryId = (retrying[0] as any).messageId;
    expect(painted.some((e) => (e as any).messageId === retryId)).toBe(true);
  });

  it("the retrying status carries the attempt count and the configured cap", async () => {
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const events = await collect(mw.run(input(), new MockAgent(streamRender([ROOT, BAD_CARD]))));
    const retrying = withStatus(events, "retrying");
    expect(retrying.length).toBeGreaterThanOrEqual(1);
    // First failure → we're heading into attempt 2 of the default 3.
    expect((retrying[0] as any).content.attempt).toBe(2);
    expect((retrying[0] as any).content.maxAttempts).toBe(3);
  });

  it("keeps the retry snapshot stable as the rejected attempt keeps streaming (no 1/N, errors persist)", async () => {
    // Chunk the args so the components array closes (→ reject) and MORE deltas
    // (the data tail) follow. Regression: those trailing deltas used to emit a
    // counter-only "retrying" snapshot with the stale attempt (1) and no errors,
    // which showed "1/3" and flickered the validation-issues detail away.
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const fullArgs = JSON.stringify({ surfaceId: "hotels", components: [ROOT, BAD_CARD], data: DATA });
    const deltas: BaseEvent[] = [];
    for (let i = 0; i < fullArgs.length; i += 8) {
      deltas.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: fullArgs.substring(i, i + 8) } as BaseEvent);
    }
    const events = await collect(
      mw.run(
        input(),
        new MockAgent([
          { type: EventType.RUN_STARTED, runId: "r", threadId: "t" },
          { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "render_a2ui" },
          ...deltas,
          { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
          { type: EventType.RUN_FINISHED, runId: "r", threadId: "t" },
        ] as BaseEvent[]),
      ),
    );
    const retrying = withStatus(events, "retrying");
    expect(retrying.length).toBeGreaterThanOrEqual(1);
    for (const r of retrying) {
      // The first retry is attempt 2 — attempt 1 is the initial try, never a retry.
      expect((r as any).content.attempt).toBe(2);
      // The dev detail (validation errors) persists on every retry snapshot.
      expect(Array.isArray((r as any).content.errors)).toBe(true);
      expect((r as any).content.errors.length).toBeGreaterThan(0);
    }
  });

  it("emits a hard-failure lifecycle snapshot when the tool result is an exhausted envelope", async () => {
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const errorEnvelope = JSON.stringify({ error: "Failed to generate valid A2UI after 3 attempt(s)", code: "a2ui_recovery_exhausted", attempts: [{ attempt: 1, ok: false }] });
    const events = await collect(
      mw.run(
        input(),
        new MockAgent([
          { type: EventType.RUN_STARTED, runId: "r", threadId: "t" },
          { type: EventType.TOOL_CALL_START, toolCallId: "outer1", toolCallName: "generate_a2ui" },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: "outer1", delta: '{"intent":"create"}' },
          { type: EventType.TOOL_CALL_END, toolCallId: "outer1" },
          { type: EventType.TOOL_CALL_RESULT, messageId: "m1", toolCallId: "outer1", content: errorEnvelope } as BaseEvent,
          { type: EventType.RUN_FINISHED, runId: "r", threadId: "t" },
        ]),
      ),
    );
    expect(paints(events)).toHaveLength(0);
    const failed = withStatus(events, "failed");
    expect(failed.length).toBe(1);
    expect((failed[0] as any).content.error).toContain("Failed to generate");
  });

  it("stamps server-configured recovery.debugExposure onto the lifecycle snapshot (OSS-162)", async () => {
    // Server-side knob, applied to every wrapped agent (Python + TS) since this
    // middleware is the single emitter of the generation lifecycle.
    const mw = new A2UIMiddleware({ schema: CATALOG, recovery: { debugExposure: "hidden" } });
    const events = await collect(mw.run(input(), new MockAgent(streamRender([ROOT, BAD_CARD]))));
    const retrying = withStatus(events, "retrying");
    expect(retrying.length).toBeGreaterThanOrEqual(1);
    expect((retrying[0] as any).content.debugExposure).toBe("hidden");
  });

  it("omits debugExposure when unconfigured, so the client default applies (OSS-162)", async () => {
    const mw = new A2UIMiddleware({ schema: CATALOG });
    const events = await collect(mw.run(input(), new MockAgent(streamRender([ROOT, BAD_CARD]))));
    const retrying = withStatus(events, "retrying");
    expect(retrying.length).toBeGreaterThanOrEqual(1);
    expect((retrying[0] as any).content.debugExposure).toBeUndefined();
  });

  it("carries a live progressTokens by default but omits it when showProgressTokens is false", async () => {
    const on = new A2UIMiddleware({ schema: CATALOG });
    const onEvents = await collect(on.run(input(), new MockAgent(streamRender([ROOT, GOOD_CARD]))));
    expect(
      lifecycle(onEvents).some((e) => typeof (e as any).content.progressTokens === "number"),
    ).toBe(true);

    const off = new A2UIMiddleware({ schema: CATALOG, recovery: { showProgressTokens: false } });
    const offEvents = await collect(off.run(input(), new MockAgent(streamRender([ROOT, GOOD_CARD]))));
    expect(
      lifecycle(offEvents).every((e) => (e as any).content.progressTokens === undefined),
    ).toBe(true);
  });
});
