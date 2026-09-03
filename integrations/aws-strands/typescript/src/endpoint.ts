/** Express endpoint utilities for AWS Strands integration. */

import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { STATUS_CODES } from "http";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import type { StrandsAgent } from "./agent";
import { resolveLogger, type Logger } from "./logger";

/**
 * Guard for the agent route. Plain Express middleware: call `next()` to admit
 * the request, or end the response yourself (`res.status(401).json(...)`) to
 * reject it. Returning a promise is supported.
 *
 * TypeScript-only. The Python sibling's `create_strands_app` takes
 * `(agent, path, ping_path, origins)` and has no auth parameter, so there is no
 * FastAPI dependency this mirrors.
 *
 * The request must be admitted explicitly. A handler that neither calls
 * `next()` nor answers the request leaves it pending, exactly as any other
 * Express middleware would, so a callback-style check is free to call `next()`
 * long after it returns.
 *
 * Failing closed is handled for you: a thrown error, a rejected promise, or
 * `next(error)` answers the error's own `status` / `statusCode` when it carries
 * a usable HTTP error code and `500` otherwise, with a generic body either way,
 * logs the error through the adapter's logger, and never reaches the agent.
 *
 * `next("route")` and `next("router")` are Express control-flow signals rather
 * than failures, and are forwarded as such: the agent does not run, and no
 * error is answered.
 *
 * The return value is ignored, but a returned promise is awaited so that a
 * rejection can fail closed. It is typed `unknown` rather than
 * `void | Promise<void>` so that an existing Express `RequestHandler`, whose
 * own declared return type is wider than that, is assignable here.
 */
export type StrandsAuthMiddleware = (
  req: Request,
  res: Response,
  next: (error?: unknown) => void,
) => unknown;

export interface AddStrandsEndpointOptions {
  path: string;
  /**
   * Optional guard for this route. Omitted, the route is unauthenticated,
   * which is the default and unchanged behaviour.
   */
  auth?: StrandsAuthMiddleware;
  /**
   * Optional route-scoped body parser. It is mounted after `auth` and before
   * the agent handler, so an unauthenticated request can be rejected without
   * first buffering or parsing its body. For example:
   * `bodyParser: express.json({ limit: "50mb" })`.
   *
   * Omit this when the app has already populated `req.body`. In that case the
   * caller owns the order of its app-wide middleware relative to this route.
   */
  bodyParser?: RequestHandler;
}

const ADD_STRANDS_ENDPOINT_OPTION_KEYS = [
  "path",
  "auth",
  "bodyParser",
] as const;

const ADD_STRANDS_ENDPOINT_OPTION_KEY_SET = new Set<string>(
  ADD_STRANDS_ENDPOINT_OPTION_KEYS,
);

function assertAddStrandsEndpointOptions(
  options: unknown,
): asserts options is AddStrandsEndpointOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("addStrandsExpressEndpoint options must be an object.");
  }

  const values = options as Record<string, unknown>;
  const unknown = Object.keys(values).filter(
    (key) => !ADD_STRANDS_ENDPOINT_OPTION_KEY_SET.has(key),
  );
  if (unknown.length > 0) {
    const plural = unknown.length === 1 ? "option" : "options";
    throw new Error(
      `addStrandsExpressEndpoint received unknown ${plural} ${unknown
        .map((key) => `\`${key}\``)
        .join(", ")}. A misspelled security option would be ignored and ` +
        `silently leave the route without it. Valid options are ` +
        `${ADD_STRANDS_ENDPOINT_OPTION_KEYS.map((key) => `\`${key}\``).join(", ")}.`,
    );
  }

  if (typeof values.path !== "string") {
    throw new TypeError(
      "addStrandsExpressEndpoint option `path` must be a string.",
    );
  }
  if (values.auth !== undefined && typeof values.auth !== "function") {
    throw new TypeError(
      "addStrandsExpressEndpoint option `auth` must be a function or undefined.",
    );
  }
  if (
    values.bodyParser !== undefined &&
    typeof values.bodyParser !== "function"
  ) {
    throw new TypeError(
      "addStrandsExpressEndpoint option `bodyParser` must be an Express request handler or undefined.",
    );
  }
}

/**
 * Express control-flow signals a guard may pass to `next()`. Neither is a
 * failure: `next("route")` skips the rest of this route, `next("router")`
 * leaves the router. Express compares them as exact strings, so this does too.
 */
type ExpressControlSignal = "route" | "router";

function isControlSignal(value: unknown): value is ExpressControlSignal {
  return value === "route" || value === "router";
}

/**
 * Status to answer for a failed guard.
 *
 * The guards worth reaching for signal failure by calling `next(err)` with a
 * numeric status on the error: `express-jwt` sets `401`, and `passport` plus
 * anything built on `http-errors` do the same. A flat `500` would answer for
 * all of them and turn every rejected credential into a server fault, so an
 * error's own `status` / `statusCode` wins when it is a usable HTTP error code.
 * Anything else, including a non-integer, a success or redirect code, or no
 * status at all, falls back to `500`: the guard did fail, and there is no
 * status here worth trusting.
 */
function statusForAuthError(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  const carrier = error as { status?: unknown; statusCode?: unknown };
  for (const candidate of [carrier.status, carrier.statusCode]) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return 500;
}

/**
 * Generic body for an honoured status: the reason phrase and nothing else.
 *
 * The error's own message never goes on the wire, for a `4xx` as much as for a
 * `5xx`. A guard this adapter did not write decides what its errors say, and an
 * auth failure's message routinely names internal detail (the JWKS endpoint it
 * could not reach, a directory host, the id of a secret). Nothing in here can
 * tell a safe message from a leaking one, and a guard that wants a specific
 * body can always write it itself with `res.status(401).json(...)` instead of
 * failing, so the failure path carries the status and no prose.
 */
function bodyForAuthStatus(status: number): { error: string } {
  return { error: STATUS_CODES[status] ?? "Error" };
}

/**
 * Wrap an auth middleware so a failure inside it can neither hang the request
 * nor leak a stack trace.
 *
 * Express 5 forwards a rejected handler promise to the default error handler,
 * which serialises the stack into the response outside production, and Express
 * 4 (still an accepted peer range) does not await handlers at all, so a
 * rejection there would hang the request. Owning both paths here keeps the
 * behaviour identical across the supported range.
 *
 * Used by `addStrandsExpressEndpoint` to keep auth ahead of the optional body
 * parser in one route. Not part of the package's public surface.
 */
export function authGuard(
  auth: StrandsAuthMiddleware,
  logger: Logger,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    // One-shot: whichever of `advance` / `fail` claims the request first owns
    // it, so a late rejection after `next()` cannot answer over a live stream.
    let settled = false;
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };

    // Both exits below weigh the same pair, `headersSent` and `writableEnded`.
    // `headersSent` alone would have `fail` drop a response that had already
    // finished cleanly, which the admit path correctly leaves alone.
    const fail = (error: unknown): void => {
      // Logged before the request is claimed: a failure arriving after the
      // request was admitted has nowhere else to surface, and it is exactly the
      // one worth seeing.
      logger.error("Auth middleware failed for the agent route", error);
      if (!claim()) return;
      // Already finished, cleanly. There is no status left to set and nothing
      // left to drop.
      if (res.writableEnded) return;
      // Nothing to set a status on once the head is on the wire, so the only
      // honest move left is to drop the connection.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = statusForAuthError(error);
      res.status(status).json(bodyForAuthStatus(status));
    };

    const advance = (control?: ExpressControlSignal): void => {
      if (!claim()) return;
      // A middleware that answered the request and then continued anyway must
      // not reach the agent: the response is already spoken for, and the agent
      // would stream into a finished one.
      if (res.headersSent || res.writableEnded) return;
      if (control) {
        next(control);
        return;
      }
      next();
    };

    const proceed = (error?: unknown): void => {
      // Control flow, not failure. The agent does not run for either signal,
      // and answering an error for them would be wrong.
      if (isControlSignal(error)) {
        advance(error);
        return;
      }
      if (error !== undefined && error !== null) {
        fail(error);
        return;
      }
      advance();
    };

    try {
      await auth(req, res, proceed);
    } catch (error) {
      fail(error);
    }
  };
}

// The wire format is camelCase per the protocol, but the Python reference
// server accepts snake_case aliases (pydantic `populate_by_name=True`). Mirror
// that here so cross-SDK clients that send `thread_id` / `run_id` / etc. keep
// working against the TS adapter.
const SNAKE_TO_CAMEL: Record<string, string> = {
  thread_id: "threadId",
  run_id: "runId",
  parent_run_id: "parentRunId",
  forwarded_props: "forwardedProps",
  tool_call_id: "toolCallId",
  parent_message_id: "parentMessageId",
};

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeRunAgentInputKeys(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  if (Array.isArray(raw)) return raw.map(normalizeRunAgentInputKeys);
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(src)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const target = SNAKE_TO_CAMEL[key] ?? key;
    if (target in out) continue;
    out[target] =
      value !== null && typeof value === "object"
        ? normalizeRunAgentInputKeys(value)
        : value;
  }
  return out;
}

function isJsonContentType(req: Request): boolean {
  // `req.is()` returns false for absent/mismatching Content-Type and tolerates
  // subtypes like `application/vnd.custom+json`.
  return Boolean(req.is("application/json") || req.is("+json"));
}

// Binary protobuf framing for AG-UI events. Only selected when the caller
// explicitly mentions this media type in the Accept header — callers that
// send `*/*` or omit Accept get SSE, which is the more forgiving format for
// casual `curl -N` inspection and matches the protocol's default transport.
const PROTOBUF_MEDIA_TYPE = "application/vnd.ag-ui.event+proto";

function clientExplicitlyRequestsProtobuf(accept: string | undefined): boolean {
  if (!accept) return false;
  return accept
    .split(",")
    .map((piece) => piece.split(";")[0]?.trim().toLowerCase() ?? "")
    .some((mt) => mt === PROTOBUF_MEDIA_TYPE);
}

/** Add a Strands agent endpoint to an Express app. */
export function addStrandsExpressEndpoint(
  app: Express,
  agent: StrandsAgent,
  options: AddStrandsEndpointOptions,
): void {
  assertAddStrandsEndpointOptions(options);

  const runAgent = async (req: Request, res: Response): Promise<void> => {
    // Request boundary validation. Express's `express.json()` middleware
    // skips bodies whose Content-Type isn't JSON — it leaves `req.body` as
    // `{}` instead of rejecting, so silently invalid requests would otherwise
    // look indistinguishable from a request with an empty body. Reject them
    // here so the protocol contract (events.mdx §RunAgentInput) is enforced
    // at the HTTP edge rather than halfway through a streaming response.
    if (!isJsonContentType(req)) {
      res
        .status(415)
        .json({ error: "Unsupported Media Type: expected application/json" });
      return;
    }

    const normalized = normalizeRunAgentInputKeys(req.body);
    const parsed = RunAgentInputSchema.safeParse(normalized);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid RunAgentInput",
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
      return;
    }
    // Preserve the resume[] field if present — the protocol schema validates
    // its shape, but passes opaque payloads through unchanged for the adapter
    // to inspect (see {@link StrandsAgent._runRaw} interrupt-rule enforcement).
    const inputData: RunAgentInput = parsed.data;

    const acceptHeader = req.header("accept") ?? undefined;
    // Only hand the encoder the Accept header when the caller explicitly
    // opted into protobuf. Otherwise force SSE so `Accept: */*` doesn't
    // surprise callers with binary frames — the encoder's media-type
    // sort ranks protobuf above SSE for wildcard Accepts.
    const encoder = clientExplicitlyRequestsProtobuf(acceptHeader)
      ? new EventEncoder({ accept: acceptHeader })
      : new EventEncoder({ accept: "text/event-stream" });
    const contentType = encoder.getContentType();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeEvent = (event: BaseEvent): void => {
      // Guard against writes to a socket the client has already dropped.
      // `res.write()` on a destroyed socket throws ERR_STREAM_DESTROYED in
      // recent Node versions; older versions silently no-op. Short-circuit
      // either way so the main loop sees the disconnect on the next
      // iteration.
      if (res.destroyed || res.writableEnded) return;
      if (contentType === "text/event-stream") {
        res.write(encoder.encode(event));
      } else {
        const bytes = encoder.encodeBinary(event);
        res.write(Buffer.from(bytes));
      }
    };

    // Hold an explicit iterator so we can call `.return()` on client
    // disconnect. Without this, `res.write()` silently buffers into a
    // closed socket and the agent generator's `finally` never runs —
    // in particular, THREAD_BUSY slots never release, wedging the thread.
    const iterator = agent.run(inputData);
    let clientDisconnected = false;
    const onDisconnect = (): void => {
      if (clientDisconnected) return;
      clientDisconnected = true;
      // Fire-and-forget — the iterator's own finally will settle the
      // active-runs set, session manager, etc. A throwing finally inside
      // the generator (e.g. a cleanup hook) must NOT surface as an
      // unhandled rejection and crash the Node process, so swallow here.
      iterator.return?.().catch(() => {
        /* intentional swallow — disconnect path */
      });
    };
    // HTTP/1.1 fires `close` on the Response when the socket closes;
    // HTTP/2 reliably fires `aborted` on the Request. Listen to both so
    // disconnects under both transports trigger cleanup.
    res.once("close", onDisconnect);
    req.once("aborted", onDisconnect);

    try {
      while (true) {
        if (clientDisconnected || res.writableEnded || res.destroyed) break;
        let step: IteratorResult<BaseEvent, void>;
        try {
          step = await iterator.next();
        } catch (e) {
          // Uncaught error from the generator (should be rare; agent.run()
          // normally wraps exceptions as RUN_ERROR itself).
          if (!clientDisconnected && !res.writableEnded) {
            try {
              writeEvent({
                type: EventType.RUN_ERROR,
                message: e instanceof Error ? e.message : String(e),
                code: "STRANDS_ERROR",
              });
            } catch {
              // ignore
            }
          }
          break;
        }
        if (step.done) break;
        if (clientDisconnected || res.writableEnded || res.destroyed) break;
        try {
          writeEvent(step.value);
        } catch (e) {
          // Encoder failure. Try to deliver a RUN_ERROR, then bail.
          const errEvent: BaseEvent = {
            type: EventType.RUN_ERROR,
            message: `Encoding error: ${String(e)}`,
            code: "ENCODING_ERROR",
          };
          try {
            writeEvent(errEvent);
          } catch {
            // Swallow — response might already be broken.
          }
          break;
        }
      }
    } finally {
      res.removeListener("close", onDisconnect);
      req.removeListener("aborted", onDisconnect);
      // Make sure the generator shuts down even if we broke out without
      // consuming everything — idempotent when already exhausted.
      try {
        await iterator.return?.();
      } catch {
        // ignore
      }
      if (!res.writableEnded) res.end();
    }
  };

  const handlers: RequestHandler[] = [];
  if (options.auth) {
    // Auth failures go through the adapter's own injectable logger
    // (`StrandsAgentConfig.logger`), not straight to the console, so an app
    // that redirected the adapter's output gets these in the same place as
    // everything else the adapter logs.
    const logger = resolveLogger(agent.config.logger);
    handlers.push(authGuard(options.auth, logger));
  }
  if (options.bodyParser) {
    handlers.push(options.bodyParser);
  }
  handlers.push(runAgent);
  app.post(options.path, ...handlers);
}

/** Add a ping endpoint returning `{status: "healthy"}`. */
export function addPing(app: Express, path: string): void {
  app.get(path, (_req, res) => {
    res.json({ status: "healthy" });
  });
}

/**
 * Static description of what this adapter actually supports. Every event
 * family here can be observed on the wire; anything missing is either not
 * emitted by this adapter (e.g. `ACTIVITY_*`, `SUBAGENT_*`) or only emitted
 * in specific configurations (the `*_CHUNK` events, gated by
 * `emitChunkEvents` — use {@link capabilitiesFor} to derive the matrix
 * from a concrete agent and pick those flags up automatically).
 *
 * Exported as a plain object so consumers can fold overrides in — for
 * example, advertising `events.ACTIVITY_SNAPSHOT: true` after wiring a
 * `customResultHandler` that emits those events themselves.
 */
export interface StrandsAguiCapabilities {
  /** Semver of the AG-UI contract surface this adapter targets. */
  protocol: string;
  /** Content types the HTTP endpoint can stream. */
  transports: { sse: boolean; protobuf: boolean; websocket: boolean };
  /** Event families the adapter emits. Per-event flags, not categories. */
  events: {
    RUN_STARTED: boolean;
    RUN_FINISHED: boolean;
    RUN_ERROR: boolean;
    TEXT_MESSAGE_START: boolean;
    TEXT_MESSAGE_CONTENT: boolean;
    TEXT_MESSAGE_END: boolean;
    TEXT_MESSAGE_CHUNK: boolean;
    TOOL_CALL_START: boolean;
    TOOL_CALL_ARGS: boolean;
    TOOL_CALL_END: boolean;
    TOOL_CALL_RESULT: boolean;
    TOOL_CALL_CHUNK: boolean;
    STATE_SNAPSHOT: boolean;
    STATE_DELTA: boolean;
    MESSAGES_SNAPSHOT: boolean;
    STEP_STARTED: boolean;
    STEP_FINISHED: boolean;
    REASONING_START: boolean;
    REASONING_MESSAGE_START: boolean;
    REASONING_MESSAGE_CONTENT: boolean;
    REASONING_MESSAGE_END: boolean;
    REASONING_MESSAGE_CHUNK: boolean;
    REASONING_ENCRYPTED_VALUE: boolean;
    REASONING_END: boolean;
    CUSTOM: boolean;
    ACTIVITY_SNAPSHOT: boolean;
    ACTIVITY_DELTA: boolean;
    RAW: boolean;
  };
  /** Protocol feature flags advertised to the client. */
  features: {
    /** RunFinished.outcome interrupt + RunAgentInput.resume loop. */
    interrupts: boolean;
    /** Tool-call interrupts accept editedArgs in the resume payload. */
    toolCallInterruptEditedArgs: boolean;
    /** Resumable streams with sequence numbers. Unsupported. */
    resumableStreams: boolean;
    /** Adapter emits MESSAGES_SNAPSHOT at run lifecycle boundaries (Python parity). */
    messagesSnapshot: boolean;
    /** State delta via RFC 6902 JSON Patch. Only when a customResultHandler emits them. */
    stateDelta: boolean;
    /** Binary protobuf content negotiation (explicit Accept header). */
    protobuf: boolean;
    /** Multiple sequential runs in one HTTP stream. One run per POST. */
    multipleRunsPerStream: boolean;
    /**
     * Model citations reach the client under the `citations` key of the
     * annotated assistant message's metadata.
     *
     * True in every configuration. Chunk mode replaces `TEXT_MESSAGE_END`,
     * which is where a citation arriving after the last text delta travels, so
     * that metadata is re-emitted as a final metadata-only chunk rather than
     * being dropped with the event.
     */
    citations: boolean;
  };
}

/** Default capabilities advertised by {@link addCapabilities}. */
export const DEFAULT_CAPABILITIES: StrandsAguiCapabilities = {
  protocol: "1",
  transports: { sse: true, protobuf: true, websocket: false },
  events: {
    RUN_STARTED: true,
    RUN_FINISHED: true,
    RUN_ERROR: true,
    TEXT_MESSAGE_START: true,
    TEXT_MESSAGE_CONTENT: true,
    TEXT_MESSAGE_END: true,
    TEXT_MESSAGE_CHUNK: false,
    TOOL_CALL_START: true,
    TOOL_CALL_ARGS: true,
    TOOL_CALL_END: true,
    TOOL_CALL_RESULT: true,
    TOOL_CALL_CHUNK: false,
    STATE_SNAPSHOT: true,
    STATE_DELTA: false,
    MESSAGES_SNAPSHOT: true,
    STEP_STARTED: true,
    STEP_FINISHED: true,
    REASONING_START: true,
    REASONING_MESSAGE_START: true,
    REASONING_MESSAGE_CONTENT: true,
    REASONING_MESSAGE_END: true,
    REASONING_MESSAGE_CHUNK: false,
    REASONING_ENCRYPTED_VALUE: true,
    REASONING_END: true,
    CUSTOM: true,
    ACTIVITY_SNAPSHOT: false,
    ACTIVITY_DELTA: false,
    RAW: true,
  },
  features: {
    interrupts: true,
    toolCallInterruptEditedArgs: true,
    resumableStreams: false,
    messagesSnapshot: true,
    stateDelta: false,
    protobuf: true,
    multipleRunsPerStream: false,
    citations: true,
  },
};

/** One level of sub-field partiality — shallow `Partial<>` on nested objects. */
export type StrandsAguiCapabilitiesOverrides = {
  protocol?: StrandsAguiCapabilities["protocol"];
  transports?: Partial<StrandsAguiCapabilities["transports"]>;
  events?: Partial<StrandsAguiCapabilities["events"]>;
  features?: Partial<StrandsAguiCapabilities["features"]>;
};

/**
 * Deep-merge consumer overrides on top of the default capabilities. Unknown
 * keys in `events` / `features` / `transports` are dropped (typos shouldn't
 * silently pollute the advertised matrix).
 */
function mergeCapabilities(
  overrides?: StrandsAguiCapabilitiesOverrides,
): StrandsAguiCapabilities {
  if (!overrides) return structuredClone(DEFAULT_CAPABILITIES);
  const pick = <K extends string>(
    defaults: Record<K, boolean>,
    override: Partial<Record<K, boolean>> | undefined,
  ): Record<K, boolean> => {
    const out = { ...defaults };
    if (!override) return out;
    for (const key of Object.keys(override) as K[]) {
      if (key in defaults) {
        const v = override[key];
        if (typeof v === "boolean") out[key] = v;
      }
      // Silently drop unknown keys — typos shouldn't leak into the JSON.
    }
    return out;
  };
  return {
    protocol: overrides.protocol ?? DEFAULT_CAPABILITIES.protocol,
    transports: pick(DEFAULT_CAPABILITIES.transports, overrides.transports),
    events: pick(DEFAULT_CAPABILITIES.events, overrides.events),
    features: pick(DEFAULT_CAPABILITIES.features, overrides.features),
  };
}

/**
 * Derive capabilities from a concrete StrandsAgent instance, flipping the
 * chunk-event flags based on whether the agent is configured to emit chunks.
 * When chunks are on, the explicit triples are suppressed, so the advertised
 * matrix reflects what the client will actually observe.
 */
export function capabilitiesFor(
  agent: { config: { emitChunkEvents?: boolean } },
  overrides?: StrandsAguiCapabilitiesOverrides,
): StrandsAguiCapabilities {
  const base = mergeCapabilities(overrides);
  if (agent.config.emitChunkEvents) {
    base.events.TEXT_MESSAGE_START = false;
    base.events.TEXT_MESSAGE_CONTENT = false;
    base.events.TEXT_MESSAGE_END = false;
    base.events.TEXT_MESSAGE_CHUNK = true;
    base.events.TOOL_CALL_START = false;
    base.events.TOOL_CALL_ARGS = false;
    base.events.TOOL_CALL_END = false;
    base.events.TOOL_CALL_CHUNK = true;
    base.events.REASONING_MESSAGE_START = false;
    base.events.REASONING_MESSAGE_CONTENT = false;
    base.events.REASONING_MESSAGE_END = false;
    base.events.REASONING_MESSAGE_CHUNK = true;
  }
  return base;
}

/**
 * Add a capabilities-advertisement endpoint.
 *
 * Frontends can GET this path to discover which AG-UI event families and
 * protocol features the adapter supports, without having to probe empirically.
 *
 * Two forms:
 * - `addCapabilities(app, path, overrides?)` — static matrix (back-compat).
 * - `addCapabilities(app, path, { agent })` — derives the matrix from a live
 *   `StrandsAgent`, picking up `emitChunkEvents` automatically.
 */
export function addCapabilities(
  app: Express,
  path: string,
  capabilities?:
    | StrandsAguiCapabilitiesOverrides
    | {
        agent: { config: { emitChunkEvents?: boolean } };
        overrides?: StrandsAguiCapabilitiesOverrides;
      },
): void {
  const resolved =
    capabilities && typeof capabilities === "object" && "agent" in capabilities
      ? capabilitiesFor(capabilities.agent, capabilities.overrides)
      : mergeCapabilities(
          capabilities as StrandsAguiCapabilitiesOverrides | undefined,
        );
  app.get(path, (_req, res) => {
    res.json(resolved);
  });
}
