import { BEST_EFFORT_SEND_TIMEOUT_MS } from "./constants";
import type { ManagedAgentsErrorContext, ManagedAgentsErrorHandler } from "./types";

/** Whether `value` is thenable, without assuming it is a real Promise. */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null | undefined)?.then === "function";

/**
 * Settle once `pending` does, or once `timeoutMs` elapses — whichever is first.
 *
 * The hook is consumer code on the run's critical path, so it gets the same
 * bound as any other best-effort call. Without one, a hook that never settles
 * (`await fetch(...)` to a host that blackholes the connection) would hold the
 * caller forever: the run's terminal event would never be emitted, the stream
 * would never complete, and the thread's run gate would never be released, so
 * every later run on that thread would be refused for the process's lifetime.
 * Abandoning the hook is the lesser loss — the telemetry is best-effort, the run
 * is not.
 */
const settleWithin = (pending: PromiseLike<unknown>, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    // Never let a pending report keep the process alive on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
    const settled = () => {
      clearTimeout(timer);
      resolve();
    };
    pending.then(settled, settled);
  });

/**
 * Hand a swallowed failure to the error hook.
 *
 * A broken hook must never break the run, and an `async` hook is a broken hook
 * waiting to happen: TypeScript accepts one wherever a `void`-returning callback
 * is expected, so its rejection would have no caller to reach and would land as
 * an unhandled rejection — which by Node's default terminates the process, the
 * exact opposite of the guarantee. A synchronous throw and an asynchronous
 * rejection are therefore both absorbed here.
 *
 * The returned promise settles once an async hook has — or once `timeoutMs`
 * elapses, whichever comes first — which lets a caller that is already
 * `await`ing await telemetry too without letting it wait forever. Callers on a
 * synchronous path can ignore it, since nothing it can do will reject.
 */
export const reportSwallowedFailure = (
  onError: ManagedAgentsErrorHandler | undefined,
  operation: string,
  error: unknown,
  ids: Omit<ManagedAgentsErrorContext, "operation"> = {},
  timeoutMs: number = BEST_EFFORT_SEND_TIMEOUT_MS,
): Promise<void> => {
  if (!onError) {
    // No hook configured — the default. Without this the cause would be
    // discarded outright, because RUN_ERROR deliberately carries no third-party
    // text: an operator with a rotated API key would see "The run failed." and
    // an empty log. Written to stderr, never to the client, so the redaction the
    // client relies on is untouched.
    console.error(`[claude-managed-agents] ${operation} failed`, { ...ids }, error);
    return Promise.resolve();
  }
  let pending: unknown;
  try {
    pending = onError(error, { operation, ...ids });
  } catch {
    return Promise.resolve(); // ignored on purpose
  }
  if (!isThenable(pending)) return Promise.resolve();
  return settleWithin(pending, timeoutMs);
};
