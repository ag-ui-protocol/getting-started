/**
 * Shared HTTP harness for the CORS and transport suites.
 *
 * Everything here boots a real Express app on an ephemeral port and reads real
 * response headers back, because the recurring defect in this area has been an
 * assertion about what was passed to a mocked `cors` factory standing in for an
 * assertion about what the app actually emits.
 */

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import type { AddressInfo } from "net";

import { createStrandsApp, type CreateStrandsAppOptions } from "../server";
import { StrandsAgent } from "../agent";

/** Agent that yields a fixed run and counts invocations. */
export class FixedAgent extends StrandsAgent {
  private readonly _events: BaseEvent[];
  /** Incremented on every `run()`, so a test can assert the agent never ran. */
  public runs = 0;

  constructor(events?: BaseEvent[]) {
    super({
      agent: {
        model: {},
        tools: [],
        toolRegistry: {
          list: () => [],
          add() {},
          get: () => undefined,
          remove() {},
        },
        sessionManager: undefined,
      } as unknown as import("@strands-agents/sdk").Agent,
      name: "fixed",
    });
    this._events = events ?? [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ];
  }

  async *run(_input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    this.runs += 1;
    for (const e of this._events) yield e;
  }
}

export interface StartedApp {
  port: number;
  agent: FixedAgent;
  close: () => Promise<void>;
}

/**
 * Bind an app to an ephemeral port.
 *
 * Two failure modes, and each needs its own handler. A bind failure
 * (EADDRINUSE, a permission denial) arrives before the promise settles, so it
 * rejects: without that the suite would report a slow hang instead of the
 * actual failure. Anything the server emits *after* a successful bind cannot
 * be carried by a promise that already resolved, so the rejecting handler is
 * detached and replaced by one that re-raises. Leaving the first handler
 * attached is what would swallow every post-bind error, since rejecting an
 * already-settled promise is a silent no-op.
 */
export function listen(
  app: import("express").Express,
): Promise<import("http").Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      server.removeListener("error", reject);
      // Thrown synchronously out of `emit`, which surfaces it as an uncaught
      // exception and fails the run. Loud beats lost for a server fault the
      // suite has no other channel for.
      server.once("error", (error) => {
        throw error;
      });
      resolve(server);
    });
    server.once("error", reject);
  });
}

export function closeServer(server: import("http").Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

/** Boot `createStrandsApp` with the given options on an ephemeral port. */
export async function startApp(
  options?: CreateStrandsAppOptions,
): Promise<StartedApp> {
  const agent = new FixedAgent();
  const app = await createStrandsApp(agent, options);
  const server = await listen(app);
  const port = (server.address() as AddressInfo).port;
  return { port, agent, close: () => closeServer(server) };
}

/** Every CORS response header these suites assert on. */
export interface CorsHeaders {
  status: number;
  allowOrigin: string | null;
  allowCredentials: string | null;
  allowMethods: string | null;
  allowHeaders: string | null;
  vary: string | null;
}

function readCorsHeaders(res: Response): CorsHeaders {
  return {
    status: res.status,
    allowOrigin: res.headers.get("access-control-allow-origin"),
    allowCredentials: res.headers.get("access-control-allow-credentials"),
    allowMethods: res.headers.get("access-control-allow-methods"),
    allowHeaders: res.headers.get("access-control-allow-headers"),
    vary: res.headers.get("vary"),
  };
}

export interface PreflightOptions {
  /** Method the preflight asks permission for. Default `POST`. */
  requestMethod?: string;
  /**
   * Value for `Access-Control-Request-Headers`. Omit it to send no such header
   * at all; passing one is what makes `cors`'s verbatim reflection observable.
   */
  requestHeaders?: string;
  /** Path to preflight. Default the agent route. */
  path?: string;
}

/** Issue a CORS preflight (OPTIONS) carrying an Origin and read the headers back. */
export async function preflight(
  port: number,
  origin: string,
  options: PreflightOptions = {},
): Promise<CorsHeaders> {
  const res = await fetch(`http://127.0.0.1:${port}${options.path ?? "/"}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": options.requestMethod ?? "POST",
      ...(options.requestHeaders
        ? { "Access-Control-Request-Headers": options.requestHeaders }
        : {}),
    },
  });
  await res.text();
  return readCorsHeaders(res);
}

/** A well-formed `RunAgentInput` body. */
export function runAgentInputPayload(): string {
  return JSON.stringify({
    threadId: "t",
    runId: "r",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
}

export interface PostRunOptions {
  /**
   * `Content-Type` to send. `null` sends the payload as bytes instead of as a
   * string so the request genuinely arrives with no `Content-Type` at all:
   * undici stamps `text/plain;charset=UTF-8` on a string body, which is a
   * mismatching type rather than an absent one.
   */
  contentType?: string | null;
  origin?: string;
  headers?: Record<string, string>;
  path?: string;
}

export interface PostRunResult extends CorsHeaders {
  body: string;
}

/**
 * POST an arbitrary body and read status, body and CORS headers.
 *
 * Separate from {@link postRun} because the request-boundary failures live
 * outside what a well-formed payload can express: a body the JSON parser
 * itself rejects never reaches the route at all, and it is the one probe that
 * distinguishes CORS mounted ahead of `express.json()` from CORS mounted after
 * it.
 */
export async function postRaw(
  port: number,
  // Narrowed to an `ArrayBuffer`-backed view because that is what `fetch`
  // accepts as a body, and what `TextEncoder` hands back.
  body: string | Uint8Array<ArrayBuffer>,
  options: PostRunOptions = {},
): Promise<PostRunResult> {
  const {
    contentType = "application/json",
    origin,
    headers,
    path = "/",
  } = options;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
    body,
  });
  // Drain so the server-side stream terminates before the test closes the port.
  const responseBody = await res.text();
  return { ...readCorsHeaders(res), body: responseBody };
}

/** POST a well-formed `RunAgentInput` and read status, body and CORS headers. */
export function postRun(
  port: number,
  options: PostRunOptions = {},
): Promise<PostRunResult> {
  const { contentType = "application/json" } = options;
  const payload = runAgentInputPayload();
  return postRaw(
    port,
    // A string body would have undici stamp a Content-Type; bytes do not.
    contentType ? payload : new TextEncoder().encode(payload),
    options,
  );
}

/** GET a path with an Origin and read status, body and CORS headers back. */
export async function getPath(
  port: number,
  path: string,
  origin?: string,
): Promise<PostRunResult> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: origin ? { Origin: origin } : {},
  });
  const body = await res.text();
  return { ...readCorsHeaders(res), body };
}
