import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { of, lastValueFrom, Observable } from "rxjs";
import { toArray, map } from "rxjs/operators";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "@/agent";
import { Middleware } from "@/middleware";
import { enforceEvents, enforceOutgoingInput, isRecognizedEvent } from "../enforce";
import { stripUnknown } from "../strip";
import { EventSchema } from "@ag-ui/core/schemas";

class MemoryAgent extends AbstractAgent {
  constructor(private events: BaseEvent[]) {
    super({});
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of(...this.events);
  }
}

/** Records every event type it sees, transforming nothing. */
class ObservingMiddleware extends Middleware {
  public seen: string[] = [];
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNext(input, next).pipe(
      map((event) => {
        this.seen.push(String(event.type));
        return event;
      }),
    );
  }
}

const run = (threadId = "t1", runId = "r1") => ({ threadId, runId });
const START = { type: EventType.RUN_STARTED, ...run() } as BaseEvent;
const FINISH = { type: EventType.RUN_FINISHED, ...run() } as BaseEvent;

// These suites assert on warnings that gate on SUPPRESS_TRANSFORMATION_WARNINGS.
// Cleared for the duration and PUT BACK, so the suite neither depends on the
// ambient environment — a dev or CI shell may well export it, since the warning
// text itself tells users to — nor changes it for whatever vitest runs next in
// this worker. Same shape as backward-compatibility-0-0-57.test.ts.
let warnSpy: ReturnType<typeof vi.spyOn>;
let priorSuppress: string | undefined;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  priorSuppress = process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
});
afterEach(() => {
  warnSpy.mockRestore();
  if (priorSuppress === undefined) {
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  } else {
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = priorSuppress;
  }
});

describe("the enforcement boundary (in-memory path)", () => {
  it("unknown material reaches middleware, and subscribers never see it", async () => {
    // The whole point of running enforcement AFTER middleware: the unknown
    // event demonstrably arrives at a middleware, and demonstrably does not
    // arrive at a subscriber.
    const unknown = { type: "SOME_FUTURE_EVENT", payload: 1 } as unknown as BaseEvent;
    const agent = new MemoryAgent([START, unknown, FINISH]);
    const observer = new ObservingMiddleware();
    agent.use(observer);
    const subscriberSaw: string[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        subscriberSaw.push(String(event.type));
      },
    });

    await agent.runAgent({ runId: "r1" });

    expect(observer.seen).toContain("SOME_FUTURE_EVENT");
    expect(subscriberSaw).not.toContain("SOME_FUTURE_EVENT");
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("SOME_FUTURE_EVENT")),
    ).toBe(true);
  });

  it("strips unknown properties with a warning before subscribers see them", async () => {
    const decorated = {
      type: EventType.STEP_STARTED,
      stepName: "plan",
      xVendorExtra: { secret: 1 },
    } as unknown as BaseEvent;
    const stepFinished = { type: EventType.STEP_FINISHED, stepName: "plan" } as BaseEvent;
    const agent = new MemoryAgent([START, decorated, stepFinished, FINISH]);
    const seen: BaseEvent[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        seen.push(event);
      },
    });

    await agent.runAgent({ runId: "r1" });

    const step = seen.find((event) => event.type === EventType.STEP_STARTED)!;
    expect(step).toBeDefined();
    expect("xVendorExtra" in step).toBe(false);
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("/xVendorExtra"))).toBe(
      true,
    );
  });

  it("a malformed value on a known field is fatal", async () => {
    const malformed = {
      type: EventType.STEP_STARTED,
      stepName: 42, // wrong type on a described field: never repaired
    } as unknown as BaseEvent;
    const agent = new MemoryAgent([START, malformed, FINISH]);

    await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow();
  });
});

describe("enforceEvents (unit)", () => {
  it("drops an unrecognised event and keeps the stream alive", async () => {
    const events = [START, { type: "NOPE" } as unknown as BaseEvent, FINISH];
    const out = await lastValueFrom(enforceEvents()(of(...events)).pipe(toArray()));
    expect(out.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("removes an unrecognised union member non-fatally", async () => {
    // A retired content-part shape nothing translated: the part is removed
    // (with a warning), the message survives, the event validates.
    const snapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "u1",
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "hologram", beam: "☄" },
          ],
        },
      ],
    } as unknown as BaseEvent;
    const out = await lastValueFrom(enforceEvents()(of(snapshot)).pipe(toArray()));
    const message = (out[0] as unknown as { messages: Array<{ content: unknown[] }> }).messages[0];
    expect(message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("/messages/0/content/1")),
    ).toBe(true);
  });

  it("leaves the open-by-key positions untouched, null values included", async () => {
    const event = {
      type: EventType.STEP_STARTED,
      stepName: "plan",
      metadata: { finishReason: null, nested: { deep: [1, null] } },
    } as unknown as BaseEvent;
    const out = await lastValueFrom(enforceEvents()(of(event)).pipe(toArray()));
    expect((out[0] as { metadata: unknown }).metadata).toEqual({
      finishReason: null,
      nested: { deep: [1, null] },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("enforceEvents (nested required union member)", () => {
  it("cascades the drop instead of leaving an invalid husk", async () => {
    // An image part whose SOURCE kind is unknown: the source is required, so
    // stripping just the source would leave a part the validator rejects
    // fatally. The drop cascades — the whole part is removed, the message
    // survives, nothing is fatal.
    const snapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "u1",
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "quantum-link", value: "?" } },
          ],
        },
      ],
    } as unknown as BaseEvent;
    const out = await lastValueFrom(enforceEvents()(of(snapshot)).pipe(toArray()));
    const message = (out[0] as unknown as { messages: Array<{ content: unknown[] }> }).messages[0];
    expect(message.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("isRecognizedEvent", () => {
  it("narrows to the known set", () => {
    expect(isRecognizedEvent(START)).toBe(true);
    expect(isRecognizedEvent({ type: "MYSTERY" })).toBe(false);
  });
});

describe("stripUnknown (unit)", () => {
  it("reports the path of everything it removes", () => {
    const schema = EventSchema.options.find(
      (option) =>
        (option as unknown as { shape: { type: { value: string } } }).shape.type.value ===
        EventType.STEP_STARTED,
    )!;
    const { value, stripped } = stripUnknown(
      { type: EventType.STEP_STARTED, stepName: "plan", extra: 1 },
      schema as never,
    );
    expect(stripped).toEqual(["/extra"]);
    expect(value).toEqual({ type: EventType.STEP_STARTED, stepName: "plan" });
  });
});

describe("enforceOutgoingInput", () => {
  it("strips unknown material from the outgoing input with a warning", () => {
    const input = {
      threadId: "t1",
      runId: "r1",
      messages: [],
      forwardedProps: { anything: { goes: true } },
      xInternalBookkeeping: 1,
    } as unknown as RunAgentInput;
    const out = enforceOutgoingInput(input);
    expect("xInternalBookkeeping" in out).toBe(false);
    // The opaque positions stay whole.
    expect(out.forwardedProps).toEqual({ anything: { goes: true } });
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("/xInternalBookkeeping")),
    ).toBe(true);
  });

  it("a malformed known field is fatal before transmission", () => {
    const input = { threadId: 5, runId: "r1", messages: [] } as unknown as RunAgentInput;
    expect(() => enforceOutgoingInput(input)).toThrow();
  });

  it("fails the run through its error handling, never synchronously", async () => {
    // A fatal outgoing input must travel the run's error path — a throw
    // during pipeline construction would also reject the (async) runAgent
    // promise, so the rejection alone proves nothing. What distinguishes the
    // paths is the lifecycle: catchError feeds onRunFailed, finalisation
    // resolves the completion machinery, and the agent is reusable after.
    const { HttpAgent } = await import("@/agent/http");
    const agent = new HttpAgent({ url: "https://example.test/agent" });
    const failures: unknown[] = [];
    agent.subscribe({
      onRunFailed: (params) => {
        failures.push(params.error);
      },
    });
    await expect(
      agent.runAgent({ forwardedProps: undefined, runId: 5 as unknown as string }),
    ).rejects.toThrow();
    expect(failures).toHaveLength(1);
    expect(agent.isRunning).toBe(false);
  });
});

describe("objects the spec leaves open", () => {
  // RFC 6902 section 4 requires an operation to IGNORE members it does not
  // define rather than reject them, so the schema leaves the six operations
  // open while closing everything else. Enforcement has to honour that: a
  // conformant patch must arrive whole, and warning about it would train
  // readers to ignore warnings that are usually real.
  it("keeps extra members on a JSON Patch operation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = {
      type: EventType.STATE_DELTA,
      delta: [{ op: "remove", path: "/a", value: 1, ext: "keep me" }],
    } as unknown as BaseEvent;

    const [result] = await lastValueFrom(of(event).pipe(enforceEvents(), toArray()));

    expect((result as unknown as { delta: unknown[] }).delta).toEqual([
      { op: "remove", path: "/a", value: 1, ext: "keep me" },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // The mark is per object, not a general loosening: everything else stays
  // closed, so the tolerance middleware relies on is unchanged.
  it("still strips extra members on an object the spec closes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      bogus: 1,
    } as unknown as BaseEvent;

    const [result] = await lastValueFrom(of(event).pipe(enforceEvents(), toArray()));

    expect(result).not.toHaveProperty("bogus");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("enforcement runs before chunk expansion", () => {
  // A chunk is an event of its own, so it is validated as one before anything
  // expands it. Expanding first handed enforcement already-repaired input: the
  // expander replaced a falsy role with "assistant", so the SAME defect was
  // fatal when a producer sent it plainly and invisible when it sent it as a
  // chunk. Which form a producer happened to use decided whether its bug was
  // reported.
  it("rejects a malformed value on a chunk, as it does on a plain event", async () => {
    const chunked = new MemoryAgent([
      START,
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", role: 0, delta: "hi" } as unknown as BaseEvent,
      FINISH,
    ]);
    const plain = new MemoryAgent([
      START,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: 0 } as unknown as BaseEvent,
      FINISH,
    ]);

    await expect(chunked.runAgent()).rejects.toThrow();
    await expect(plain.runAgent()).rejects.toThrow();
  });

  // The reordering must not cost the run its expansion: a well-formed chunk
  // still becomes the events it always did, and verification still sees them
  // paired, which is why it stays after expansion rather than moving with it.
  it("still expands a well-formed chunk into a verified message", async () => {
    const seen: string[] = [];
    const agent = new MemoryAgent([
      START,
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "hi" } as unknown as BaseEvent,
      FINISH,
    ]);

    await agent.runAgent(undefined, {
      onEvent: ({ event }) => {
        seen.push(String(event.type));
      },
    });

    expect(seen).toContain(EventType.TEXT_MESSAGE_START);
    expect(seen).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(seen).toContain(EventType.TEXT_MESSAGE_END);
  });
});

describe("expansion does not repair, whichever stage reaches it first", () => {
  // agent.ts runs enforcement before expansion on all three of its pipelines,
  // but Middleware.runNext expands INSIDE the middleware chain — upstream of
  // enforcement. So the expander cannot lean on having been handed valid input:
  // whether a producer's defect was reported would otherwise depend on whether
  // the consumer happened to install a middleware.
  const chunk = (extra: Record<string, unknown>) =>
    ({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "hi", ...extra }) as unknown as BaseEvent;

  it("keeps a malformed role fatal with a middleware installed", async () => {
    const withMiddleware = new MemoryAgent([START, chunk({ role: null }), FINISH]);
    withMiddleware.use(new ObservingMiddleware());
    const without = new MemoryAgent([START, chunk({ role: null }), FINISH]);

    await expect(withMiddleware.runAgent()).rejects.toThrow();
    await expect(without.runAgent()).rejects.toThrow();
  });

  it("keeps a null subagentRunId fatal with a middleware installed", async () => {
    const withMiddleware = new MemoryAgent([START, chunk({ subagentRunId: null }), FINISH]);
    withMiddleware.use(new ObservingMiddleware());
    const without = new MemoryAgent([START, chunk({ subagentRunId: null }), FINISH]);

    await expect(withMiddleware.runAgent()).rejects.toThrow();
    await expect(without.runAgent()).rejects.toThrow();
  });

  // The other half: an ABSENT role still becomes assistant, which is the
  // documented default and the only thing this stage legitimately materialises.
  it("still fills in an absent role with a middleware installed", async () => {
    const agent = new MemoryAgent([START, chunk({}), FINISH]);
    agent.use(new ObservingMiddleware());

    const result = await agent.runAgent();

    expect(result.newMessages[0]).toHaveProperty("role", "assistant");
  });
});
