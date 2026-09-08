import { vi } from "vitest";

/**
 * One scripted stream entry. A plain event object is yielded; a Promise
 * blocks the stream until it settles (a gate to hold a run in flight); an
 * Error is thrown at that point (mid-stream failure).
 */
export type StreamStep = unknown;

/** A scripted stand-in for the Anthropic client's managed-agents surface. */
export interface FakeClientOptions {
  /** Steps yielded by each successive `events.stream` call. */
  streams?: StreamStep[][];
  agentTools?: unknown[];
  sessionId?: string;
  /**
   * Scripted results for successive `events.send` calls. An Error entry
   * makes that call reject; `undefined` (or running out) resolves normally.
   */
  sendResults?: (Error | undefined)[];
  /** Make `sessions.create` / `sessions.update` reject with this error. */
  createError?: Error;
  updateError?: Error;
  /**
   * Hold `sessions.create` until this settles. A call given a signal rejects as
   * soon as that signal aborts; one given none hangs, which is exactly what an
   * unbounded call does to a run.
   */
  createGate?: Promise<void>;
  /** As {@link createGate}, for `agents.retrieve`. */
  retrieveGate?: Promise<void>;
}

const abortError = () => Object.assign(new Error("Request was aborted."), { name: "AbortError" });

/** Resolve with `promise`, unless `signal` aborts first (then reject). */
const untilAborted = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

export function createFakeClient(options: FakeClientOptions = {}) {
  const streams = [...(options.streams ?? [])];
  const sendResults = [...(options.sendResults ?? [])];
  const sent: { sessionId: string; events: unknown[] }[] = [];
  /** Every send attempt, including ones rejected for an aborted signal. */
  const sendOptions: { sessionId: string; signal?: AbortSignal; events: unknown[] }[] = [];

  const stream = vi.fn(async (_sessionId: string, _params?: unknown, requestOptions?: { signal?: AbortSignal }) => {
    const steps = streams.shift() ?? [];
    const signal = requestOptions?.signal;
    const controller = new AbortController();
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        for (const step of steps) {
          if (controller.signal.aborted) return;
          if (signal?.aborted) throw abortError();
          if (step instanceof Promise) {
            await untilAborted(step, signal); // gate: hold the stream open
            continue;
          }
          if (step instanceof Error) throw step;
          yield step;
        }
        if (signal?.aborted) throw abortError();
      },
    };
  });

  const send = vi.fn(
    async (sessionId: string, params: { events: unknown[] }, requestOptions?: { signal?: AbortSignal }) => {
      const signal = requestOptions?.signal;
      sendOptions.push({ sessionId, signal, events: params.events });
      // A send whose signal is already aborted never reaches the API. Modelling
      // that is what makes the "best-effort sends survive the run's abort"
      // contract observable: a send that reuses the run's aborted signal —
      // instead of its own bounded timeout — fails here rather than passing.
      if (signal?.aborted) throw abortError();
      const failure = sendResults.shift();
      if (failure) throw failure;
      sent.push({ sessionId, events: params.events });
      return { data: params.events.map((event, i) => ({ ...(event as object), id: `sent_${sent.length}_${i}` })) };
    },
  );

  /** The signal every non-send call was made with, keyed by call. */
  const callSignals: { call: string; signal?: AbortSignal }[] = [];

  const create = vi.fn(async (_params: any, requestOptions?: { signal?: AbortSignal }) => {
    callSignals.push({ call: "sessions.create", signal: requestOptions?.signal });
    if (options.createGate) await untilAborted(options.createGate, requestOptions?.signal);
    if (options.createError) throw options.createError;
    return { id: options.sessionId ?? "sesn_1" };
  });
  const update = vi.fn(async (_sessionId: string, _params: any, requestOptions?: { signal?: AbortSignal }) => {
    callSignals.push({ call: "sessions.update", signal: requestOptions?.signal });
    if (options.updateError) throw options.updateError;
    return {};
  });
  const retrieve = vi.fn(async (_agentId: string, _params?: any, requestOptions?: { signal?: AbortSignal }) => {
    callSignals.push({ call: "agents.retrieve", signal: requestOptions?.signal });
    if (options.retrieveGate) await untilAborted(options.retrieveGate, requestOptions?.signal);
    return { tools: options.agentTools ?? [{ type: "agent_toolset_20260401", configs: [], default_config: {} }] };
  });

  const client = {
    beta: {
      agents: { retrieve },
      sessions: {
        create,
        update,
        events: { stream, send },
      },
    },
  };

  return { client: client as any, sent, sendOptions, callSignals, spies: { stream, send, create, update, retrieve } };
}
