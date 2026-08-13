/** Express endpoint utilities for AWS Strands integration. */

import type { Express, Request, Response } from "express";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import type { StrandsAgent } from "./agent";

export interface AddStrandsEndpointOptions {
  path: string;
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
  app.post(options.path, async (req: Request, res: Response) => {
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
  });
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
 * emitted by this adapter (e.g. `ACTIVITY_*`, `RAW`) or only emitted in
 * specific configurations (the `*_CHUNK` events, gated by
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
    RAW: false,
  },
  features: {
    interrupts: true,
    toolCallInterruptEditedArgs: true,
    resumableStreams: false,
    messagesSnapshot: true,
    stateDelta: false,
    protobuf: true,
    multipleRunsPerStream: false,
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
