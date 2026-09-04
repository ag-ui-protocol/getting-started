/**
 * A producer-sent RUN_ERROR fails THAT run, and only that run.
 *
 * The stream is well formed — an agent honestly reporting that its run failed
 * is not a protocol violation — so the client accepts it. What it must not do
 * is hand the caller a resolved `runAgent()` as though the run had succeeded,
 * which is what it used to do: the reducer ran the subscribers for the event
 * and then returned updates, and nothing anywhere failed.
 *
 * The agent INSTANCE survives: a new run on the same object starts clean.
 */
import { Observable, Subject, of } from "rxjs";
import { transformHttpEventStream } from "@/transform/http";
import { HttpEventType, type HttpEvent } from "@/run/http-request";
import { AbstractAgent } from "../agent";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";
import type { AgentSubscriber } from "../subscriber";
import type { RunAgentResult } from "../agent";

/** Replays a different scripted stream on each successive run. */
class ScriptedAgent extends AbstractAgent {
  public runs = 0;
  constructor(private scripts: BaseEvent[][]) {
    super();
    this.debug = false;
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    const script = this.scripts[Math.min(this.runs, this.scripts.length - 1)];
    this.runs += 1;
    return of(...script);
  }
}

const started = (runId: string) =>
  ({ type: EventType.RUN_STARTED, threadId: "t", runId }) as RunStartedEvent;
const finished = (runId: string, result?: unknown) =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "t",
    runId,
    ...(result !== undefined && { result }),
  }) as RunFinishedEvent;
const message = (id: string, delta: string): BaseEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent,
];

/**
 * Runs `body` and reports what console.error saw.
 *
 * "Resolves" is only half of the abort contract; the other half is that it
 * resolves QUIETLY. agent.ts logs "Agent execution failed:" before rethrowing
 * for every failure it does not recognise as an abort, so that line is the
 * observable difference between a swallowed abort and a failure that merely
 * happened not to reject.
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

/** Runs with console.error muted — the failure path logs before rethrowing. */
async function failing(body: () => Promise<unknown>): Promise<Error> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await body();
  } catch (error) {
    return error as Error;
  } finally {
    errors.mockRestore();
  }
  throw new Error("expected the run to fail, it resolved");
}

describe("a producer-sent RUN_ERROR", () => {
  it("fails runAgent() with the message the producer sent", async () => {
    const agent = new ScriptedAgent([
      [
        started("r1"),
        { type: EventType.RUN_ERROR, message: "the tool host was unreachable" } as BaseEvent,
      ],
    ]);
    const error = await failing(() => agent.runAgent({ runId: "r1" }));
    expect(error.message).toContain("the tool host was unreachable");
  });

  it("carries the producer's code alongside the message", async () => {
    const agent = new ScriptedAgent([
      [
        started("r1"),
        {
          type: EventType.RUN_ERROR,
          message: "unreachable",
          code: "UNAVAILABLE",
        } as BaseEvent,
      ],
    ]);
    const error = await failing(() => agent.runAgent({ runId: "r1" }));
    expect((error as Error & { code?: string }).code).toBe("UNAVAILABLE");
  });

  it("fails the run even when it arrives after RUN_FINISHED", async () => {
    // The verifier admits a late RUN_ERROR — a failure that surfaced after the
    // run reported success — and the spec says the consumer MUST then treat
    // the run as failed. So the success result must not be handed back.
    const agent = new ScriptedAgent([
      [
        started("r1"),
        ...message("m1", "delivered before the failure"),
        finished("r1", { answer: 42 }),
        { type: EventType.RUN_ERROR, message: "the transport failed while flushing" } as BaseEvent,
      ],
    ]);
    const error = await failing(() => agent.runAgent({ runId: "r1" }));
    expect(error.message).toContain("the transport failed while flushing");
    // Everything delivered before the failure is kept.
    expect(agent.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("still reports the failure to onRunErrorEvent subscribers", async () => {
    const agent = new ScriptedAgent([
      [started("r1"), { type: EventType.RUN_ERROR, message: "boom" } as BaseEvent],
    ]);
    const seen: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen.push((event as { message?: string }).message ?? "");
      },
    } as AgentSubscriber);
    await failing(() => agent.runAgent({ runId: "r1" }));
    expect(seen).toEqual(["boom"]);
  });

  it("is suppressed when a subscriber stops the event's propagation", async () => {
    // stopPropagation means the subscriber took responsibility for the event.
    // Failing anyway would make the opt-out unusable.
    const agent = new ScriptedAgent([
      [
        started("r1"),
        { type: EventType.RUN_ERROR, message: "handled by the app" } as BaseEvent,
      ],
    ]);
    let consulted = 0;
    agent.subscribe({
      onRunErrorEvent: () => {
        consulted += 1;
        return { stopPropagation: true };
      },
    } as AgentSubscriber);

    let result: RunAgentResult | undefined;
    const logged = await loggedErrorsDuring(async () => {
      result = await agent.runAgent({ runId: "r1" });
    });

    // The opt-out was actually exercised, and the run ended as a clean one:
    // no rethrow, nothing logged as a failure, the instance idle afterwards.
    // "Resolves with something defined" is true of a run that ignored the
    // subscriber entirely.
    expect(consulted).toBe(1);
    expect(result?.newMessages).toEqual([]);
    expect(logged).not.toContain("Agent execution failed");
    expect(agent.isRunning).toBe(false);
  });

  it("leaves the agent usable: the next run on the same instance succeeds", async () => {
    const agent = new ScriptedAgent([
      [started("r1"), { type: EventType.RUN_ERROR, message: "first run failed" } as BaseEvent],
      [started("r2"), ...message("m2", "the second run works"), finished("r2", "ok")],
    ]);

    await failing(() => agent.runAgent({ runId: "r1" }));

    const second = await agent.runAgent({ runId: "r2" });
    expect(second.result).toBe("ok");
    expect(second.newMessages.map((m) => m.id)).toEqual(["m2"]);
    expect(agent.isRunning).toBe(false);
    expect(agent.pendingInterrupts).toEqual([]);
  });
});

describe("the abort contract is unchanged", () => {
  it("resolves for a real AbortError coming up through the HTTP transform", async () => {
    // Not a hand-written event: this drives transform/http.ts itself, which is
    // where the abort -> `RUN_ERROR code: "abort"` + complete substitution
    // lives. It is the one path where making RUN_ERROR fail a run could have
    // turned every abortRun() into a rejection.
    class TransportAgent extends AbstractAgent {
      run(_input: RunAgentInput): Observable<BaseEvent> {
        const http = new Subject<HttpEvent>();
        const events$ = transformHttpEventStream(http);
        queueMicrotask(() => {
          http.next({
            type: HttpEventType.HEADERS,
            status: 200,
            headers: new Headers([["content-type", "text/event-stream"]]),
          });
          http.error(Object.assign(new Error("The operation was aborted."), {
            name: "AbortError",
          }));
        });
        return events$;
      }
    }
    const agent = new TransportAgent();
    const seen: Array<Record<string, unknown>> = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen.push(event as unknown as Record<string, unknown>);
      },
    } as AgentSubscriber);

    const logged = await loggedErrorsDuring(() => agent.runAgent({ runId: "aborted" }));

    // Quietly, which is the whole contract: the synthesized RUN_ERROR reached
    // the reducer, carried the abort marker, and was NOT reported as a failure.
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe("abort");
    expect(seen[0].rawEvent).toBeInstanceOf(Error);
    expect(logged).not.toContain("Agent execution failed");
    expect(agent.isRunning).toBe(false);
  });

  it("resolves for the RUN_ERROR the transport synthesises on abort", async () => {
    // transform/http.ts turns an AbortError into `RUN_ERROR code: "abort"` and
    // completes the stream, so that aborting a run is a graceful end rather
    // than a failure. Making a producer-sent RUN_ERROR reject must not turn
    // every abortRun() into a rejection.
    //
    // The synthesized event carries the ABORT ERROR OBJECT as its `rawEvent`,
    // and that — not the `code`, which is an open string any producer may
    // send — is what marks it as this client's own abort. Scripted here with
    // the same marker the transport attaches; the test above drives the real
    // transport end to end.
    const agent = new ScriptedAgent([
      [
        started("r1"),
        {
          type: EventType.RUN_ERROR,
          message: "Request aborted",
          code: "abort",
          rawEvent: Object.assign(new Error("The operation was aborted."), {
            name: "AbortError",
          }),
        } as BaseEvent,
      ],
    ]);
    const logged = await loggedErrorsDuring(() => agent.runAgent({ runId: "r1" }));

    expect(logged).not.toContain("Agent execution failed");
    expect(agent.isRunning).toBe(false);
  });
});

describe("a producer cannot forge the abort carve-out", () => {
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

  it('fails the run for a wire RUN_ERROR whose code happens to be "abort"', async () => {
    // `RunErrorEvent.code` is an open string — the protocol defines no
    // vocabulary for it — so "abort" is a perfectly conformant thing for a
    // producer to send about its own failure. Keying the resolve-quietly
    // carve-out on the code made such a run resolve as though it had
    // succeeded, which is the exact confusion the RUN_ERROR fix exists to end.
    const agent = new WireAgent([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" },
      { type: EventType.RUN_ERROR, message: "the user cancelled", code: "abort" },
    ]);
    const error = await failing(() => agent.runAgent({ runId: "r1" }));
    expect(error.message).toContain("the user cancelled");
    expect(error.name).not.toBe("AbortError");
  });

  it("cannot forge the marker either: rawEvent off the wire is never an Error", async () => {
    // The marker is the abort error OBJECT. `JSON.parse` produces plain
    // objects, arrays and primitives and nothing else, so a producer imitating
    // it in JSON still fails the run.
    const agent = new WireAgent([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" },
      {
        type: EventType.RUN_ERROR,
        message: "pretending to be an abort",
        code: "abort",
        rawEvent: { name: "AbortError", message: "The operation was aborted." },
      },
    ]);
    const error = await failing(() => agent.runAgent({ runId: "r1" }));
    expect(error.message).toContain("pretending to be an abort");
  });

  it("keeps the abort error object intact through enforcement", async () => {
    // The carve-out only works if `rawEvent` reaches the reducer as the same
    // object the transport attached: enforcement re-parses every event through
    // the generated zod schema, and `rawEvent` is `z.any()`, an opaque
    // position the stripper and the validator both pass through untouched.
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    const agent = new ScriptedAgent([
      [
        started("r1"),
        {
          type: EventType.RUN_ERROR,
          message: "Request aborted",
          code: "abort",
          rawEvent: abortError,
        } as BaseEvent,
      ],
    ]);
    let seen: unknown;
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen = (event as { rawEvent?: unknown }).rawEvent;
      },
    } as AgentSubscriber);
    await agent.runAgent({ runId: "r1" });
    expect(seen).toBe(abortError);
    expect(seen instanceof Error).toBe(true);
  });
});
