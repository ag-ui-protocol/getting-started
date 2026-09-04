/**
 * A producer-sent RUN_ERROR does NOT end the stream.
 *
 * The verifier has always admitted a RUN_STARTED after a RUN_ERROR — it resets
 * its run state and begins a new run — and that admission is only worth
 * anything if the rest of the pipeline agrees: the reducer must keep reducing,
 * the agent must keep applying, and `runAgent()` must resolve with what the
 * later run produced. `verify/__tests__/verify.multiple-runs.test.ts` pins the
 * verifier's half in isolation, which is exactly why a reducer that failed the
 * run at RUN_ERROR could pass it while breaking the contract.
 *
 * So every test here drives the whole pipeline: scripted frames go out through
 * the real SSE transform (`transform/http.ts` + `transform/sse.ts`), exactly as
 * a producer's bytes would, and come back through verification, enforcement,
 * the reducer and the agent.
 */
import { Observable, Subject } from "rxjs";
import { transformHttpEventStream } from "@/transform/http";
import { HttpEventType, type HttpEvent } from "@/run/http-request";
import { AbstractAgent } from "../agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import type { AgentSubscriber } from "../subscriber";
import type { RunAgentResult } from "../agent";

/** Replays scripted frames through the real SSE transport, as the wire does. */
class WireAgent extends AbstractAgent {
  constructor(private frames: unknown[]) {
    super();
    this.debug = false;
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    const http = new Subject<HttpEvent>();
    const events$ = transformHttpEventStream(http);
    queueMicrotask(() => {
      http.next({
        type: HttpEventType.HEADERS,
        status: 200,
        headers: new Headers([["content-type", "text/event-stream"]]),
      });
      for (const frame of this.frames) {
        http.next({
          type: HttpEventType.DATA,
          data: new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
        });
      }
      http.complete();
    });
    return events$;
  }
}

/**
 * Runs `body` and reports what console.error saw.
 *
 * agent.ts logs "Agent execution failed:" before rethrowing for every failure
 * it does not recognise as an abort, so that line is the observable difference
 * between a run that carried on and one that merely happened not to reject.
 */
async function loggedErrorsDuring(body: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const errors = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(" ")));
  try {
    await body();
  } finally {
    errors.mockRestore();
  }
  return lines.join("\n");
}

/** What a subscriber watched happen, across both runs. */
interface Watched {
  startedRunIds: string[];
  runErrors: string[];
}

function watch(agent: AbstractAgent): Watched {
  const watched: Watched = { startedRunIds: [], runErrors: [] };
  agent.subscribe({
    onRunStartedEvent: ({ event }) => {
      watched.startedRunIds.push((event as { runId?: string }).runId ?? "");
    },
    onRunErrorEvent: ({ event }) => {
      watched.runErrors.push((event as { message?: string }).message ?? "");
    },
  } as AgentSubscriber);
  return watched;
}

const started = (runId: string) => ({
  type: EventType.RUN_STARTED,
  threadId: "t",
  runId,
});
const finished = (runId: string) => ({
  type: EventType.RUN_FINISHED,
  threadId: "t",
  runId,
  outcome: { type: "success" },
});
const message = (id: string, delta: string): unknown[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta },
  { type: EventType.TEXT_MESSAGE_END, messageId: id },
];

describe("RUN_ERROR does not end the stream", () => {
  it("a RUN_STARTED after it begins a new run, and the client carries on", async () => {
    const agent = new WireAgent([
      started("r1"),
      { type: EventType.RUN_ERROR, message: "first run failed" },
      started("r2"),
      ...message("m1", "second run"),
      finished("r2"),
    ]);
    const watched = watch(agent);

    let result: RunAgentResult | undefined;
    const logged = await loggedErrorsDuring(async () => {
      result = await agent.runAgent({ runId: "r1" });
    });

    // (a) the promise RESOLVED — no rejection anywhere in the pipeline.
    expect(result).toBeDefined();
    // (b) the failure was still reported, exactly once.
    expect(watched.runErrors).toEqual(["first run failed"]);
    // (c) the second run's message arrived and was applied.
    expect(result!.newMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(result!.newMessages.map((m) => m.content)).toEqual(["second run"]);
    expect(agent.messages.map((m) => m.id)).toEqual(["m1"]);
    // (d) two runs were observed, in order.
    expect(watched.startedRunIds).toEqual(["r1", "r2"]);
    // (e) and (f): the instance is idle, and nothing was logged as a failure.
    expect(agent.isRunning).toBe(false);
    expect(logged).not.toContain("Agent execution failed");
  });

  it("carries on the same way when the RUN_ERROR follows a finished run", async () => {
    // A failure that surfaced after the run reported success, then a new run.
    // The verifier admits the late RUN_ERROR and resets on the RUN_STARTED
    // that follows it, so the second run reduces like any other.
    const agent = new WireAgent([
      started("r1"),
      ...message("m1", "first run"),
      finished("r1"),
      { type: EventType.RUN_ERROR, message: "the transport failed while flushing" },
      started("r2"),
      ...message("m2", "second run"),
      finished("r2"),
    ]);
    const watched = watch(agent);

    let result: RunAgentResult | undefined;
    const logged = await loggedErrorsDuring(async () => {
      result = await agent.runAgent({ runId: "r1" });
    });

    expect(result).toBeDefined();
    expect(watched.runErrors).toEqual(["the transport failed while flushing"]);
    expect(watched.startedRunIds).toEqual(["r1", "r2"]);
    // Everything from both runs is kept.
    expect(agent.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result!.newMessages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(agent.isRunning).toBe(false);
    expect(logged).not.toContain("Agent execution failed");
  });

  it("resolves for a stream that simply ENDS with RUN_ERROR", async () => {
    // No further run: the stream reports the failure and completes. This is
    // the whole of the contract — the failure reaches subscribers, and the
    // caller gets a resolved promise carrying whatever was delivered. There is
    // no RUN_FINISHED, so `result` is undefined; `newMessages` holds what the
    // run produced before it failed.
    const agent = new WireAgent([
      started("r1"),
      ...message("m1", "delivered before the failure"),
      { type: EventType.RUN_ERROR, message: "the tool host was unreachable" },
    ]);
    const watched = watch(agent);

    let result: RunAgentResult | undefined;
    const logged = await loggedErrorsDuring(async () => {
      result = await agent.runAgent({ runId: "r1" });
    });

    expect(result).toBeDefined();
    expect(result!.result).toBeUndefined();
    expect(result!.newMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(watched.runErrors).toEqual(["the tool host was unreachable"]);
    expect(agent.isRunning).toBe(false);
    expect(logged).not.toContain("Agent execution failed");
  });
});
