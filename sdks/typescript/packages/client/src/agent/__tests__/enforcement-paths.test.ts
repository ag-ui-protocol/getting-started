import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";
import { scheduled, asyncScheduler, Observable } from "rxjs";
import { map } from "rxjs/operators";
import { HttpAgent } from "../http";
import { AbstractAgent } from "../agent";
import { runHttpRequest, HttpEventType } from "@/run/http-request";
import { Middleware } from "@/middleware";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import * as proto from "@ag-ui/proto";

// Every transport must feed the same boundary: middleware first, enforcement
// after. One test per path — streaming (SSE), binary (protobuf framing), and
// in-memory — each proving unknown material reaches a middleware and never a
// subscriber.

vi.mock("@/run/http-request", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runHttpRequest: vi.fn(),
}));

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

// scheduled(async): a cold synchronous source would drain into the
// transport's internal Subject before the pipeline subscribes.
const sse = (events: Array<Record<string, unknown>>) => {
  const headers = new Headers();
  headers.append("Content-Type", "text/event-stream");
  const encoder = new TextEncoder();
  return scheduled(
    [
      { type: HttpEventType.HEADERS, status: 200, headers } as const,
      ...events.map(
        (event) =>
          ({
            type: HttpEventType.DATA,
            data: encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          }) as const,
      ),
    ],
    asyncScheduler,
  );
};

const binary = (events: Array<Record<string, unknown>>) => {
  const headers = new Headers();
  headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);
  const encoder = new EventEncoder({ accept: proto.AGUI_MEDIA_TYPE });
  return scheduled(
    [
      { type: HttpEventType.HEADERS, status: 200, headers } as const,
      ...events.map(
        (event) =>
          ({
            type: HttpEventType.DATA,
            data: encoder.encodeBinary(event as never),
          }) as const,
      ),
    ],
    asyncScheduler,
  );
};

const run = { threadId: "t1", runId: "r1" };

// These suites assert on warnings that gate on SUPPRESS_TRANSFORMATION_WARNINGS.
// Cleared for the duration and PUT BACK, so the suite neither depends on the
// ambient environment — a dev or CI shell may well export it, since the warning
// text itself tells users to — nor changes it for whatever vitest runs next in
// this worker. Same shape as backward-compatibility-0-0-57.test.ts.
let warnSpy: ReturnType<typeof vi.spyOn>;
let priorSuppress: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
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

async function runThroughHttpAgent(source: Observable<unknown>) {
  (runHttpRequest as Mock).mockReturnValue(source as never);
  const agent = new HttpAgent({ url: "https://example.test/agent" });
  const observer = new ObservingMiddleware();
  agent.use(observer);
  const subscriberSaw: string[] = [];
  agent.subscribe({
    onEvent: ({ event }) => {
      subscriberSaw.push(String(event.type));
    },
  });
  await agent.runAgent({ runId: "r1" });
  return { observer, subscriberSaw };
}

describe("the boundary on the streaming (SSE) path", () => {
  it("unknown events reach middleware and never a subscriber", async () => {
    const { observer, subscriberSaw } = await runThroughHttpAgent(
      sse([
        { type: EventType.RUN_STARTED, ...run },
        { type: "SOME_FUTURE_EVENT", payload: 1 },
        { type: EventType.RUN_FINISHED, ...run },
      ]),
    );
    expect(observer.seen).toContain("SOME_FUTURE_EVENT");
    expect(subscriberSaw).not.toContain("SOME_FUTURE_EVENT");
  });

  it("a malformed known value is fatal on the SSE path", async () => {
    (runHttpRequest as Mock).mockReturnValue(
      sse([
        { type: EventType.RUN_STARTED, ...run },
        { type: EventType.STEP_STARTED, stepName: 42 },
      ]),
    );
    const agent = new HttpAgent({ url: "https://example.test/agent" });
    await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow();
  });
});

describe("the boundary on the binary (protobuf) path", () => {
  it("binary-delivered events pass through middleware and enforcement", async () => {
    const { observer, subscriberSaw } = await runThroughHttpAgent(
      binary([
        { type: EventType.RUN_STARTED, ...run },
        { type: EventType.STEP_STARTED, stepName: "plan" },
        { type: EventType.STEP_FINISHED, stepName: "plan" },
        { type: EventType.RUN_FINISHED, ...run },
      ]),
    );
    expect(observer.seen).toEqual([
      EventType.RUN_STARTED,
      EventType.STEP_STARTED,
      EventType.STEP_FINISHED,
      EventType.RUN_FINISHED,
    ]);
    expect(subscriberSaw).toEqual(observer.seen);
  });

  it("enforcement runs after middleware on the binary path", async () => {
    // A middleware decorates a binary-delivered event with an unknown
    // property; the enforcement stage must strip it before subscribers —
    // proving the order (middleware first, enforcement after) holds on this
    // transport too. What the binary wire itself can carry is exact by
    // construction, so the deviation has to be injected mid-pipeline.
    class DecoratingMiddleware extends Middleware {
      override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
        return this.runNext(input, next).pipe(
          map((event) => ({ ...event, xDecoration: 1 }) as BaseEvent),
        );
      }
    }
    (runHttpRequest as Mock).mockReturnValue(
      binary([
        { type: EventType.RUN_STARTED, ...run },
        { type: EventType.RUN_FINISHED, ...run },
      ]) as never,
    );
    const agent = new HttpAgent({ url: "https://example.test/agent" });
    agent.use(new DecoratingMiddleware());
    const seen: BaseEvent[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        seen.push(event);
      },
    });
    await agent.runAgent({ runId: "r1" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((event) => !("xDecoration" in event))).toBe(true);
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("/xDecoration"))).toBe(
      true,
    );
  });

  it("malformed binary input is fatal", async () => {
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);
    (runHttpRequest as Mock).mockReturnValue(
      scheduled(
        [
          { type: HttpEventType.HEADERS, status: 200, headers } as const,
          {
            type: HttpEventType.DATA,
            // A complete frame whose payload is not a decodable event.
            data: new Uint8Array([0, 0, 0, 3, 0xff, 0xff, 0xff]),
          } as const,
        ],
        asyncScheduler,
      ),
    );
    const agent = new HttpAgent({ url: "https://example.test/agent" });
    await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow();
  });
});
