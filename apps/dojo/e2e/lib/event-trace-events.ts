import { isDeepStrictEqual } from "node:util";

export type TraceEvent = {
  type: string;
  [field: string]: unknown;
};

export class EventTraceSseParseError extends Error {
  constructor(
    message: string,
    readonly responseBody: string,
    readonly frameIndex: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EventTraceSseParseError";
  }
}

const GENERATED_ID_FIELDS = new Set([
  "checkpointId",
  "messageId",
  "parentMessageId",
  "parentToolCallId",
  "parentRunId",
  "runId",
  "threadId",
  "toolCallId",
  "checkpoint_id",
  "langgraph_request_id",
  "message_id",
  "originalAIMessageId",
  "original_ai_message_id",
  "parent_message_id",
  "parent_tool_call_id",
  "parent_run_id",
  "run_id",
  "requestId",
  "thread_id",
  "tool_call_id",
]);

const STRUCTURED_ID_FIELDS = new Set([
  "checkpoint_ns",
  "langgraph_checkpoint_ns",
  "subagentRunId",
  "subagent_run_id",
]);

const GENERATED_ID_ARRAY_FIELDS = new Set([
  "interruptIds",
  "interrupt_ids",
  "parentIds",
  "parent_ids",
]);
const LANGCHAIN_MESSAGE_TYPES = new Set([
  "ai",
  "human",
  "system",
  "tool",
  "function",
]);
// Keys MUST be lowercase: normalizeForwardedHeaders looks them up by the
// lowercased header name, so a title-cased key here would never match.
const FORWARDED_HEADER_TOKENS = new Map([
  ["x-forwarded-for", "<forwarded-for>"],
  ["x-forwarded-host", "<forwarded-host>"],
  ["x-forwarded-port", "<forwarded-port>"],
  ["x-forwarded-proto", "<forwarded-proto>"],
]);
const ENVIRONMENT_VALUE_TOKENS = new Map([
  ["langgraph_api_url", "<langgraph-api-url>"],
  ["langgraph_version", "<langgraph-version>"],
  ["langgraph_api_version", "<langgraph-api-version>"],
]);

// Metadata keys that exist only when LangSmith tracing happens to be enabled,
// so their *presence* — not just their value — varies by environment.
//
// langgraph-api turns tracing on whenever it sees a LangSmith API key
// (LANGSMITH_CONTROL_PLANE_API_KEY defaults to LANGSMITH_API_KEY, which
// force-sets LANGSMITH_TRACING). The LangSmith client then merges every
// LANGSMITH_*/LANGCHAIN_* env var into each run's metadata dict, and
// langchain_core hands the tracer the *same* dict object the run config
// streams out — so `langgraph dev`'s LANGSMITH_LANGGRAPH_API_VARIANT=local_dev
// lands in STATE_SNAPSHOT metadata. Anyone with a LangSmith key in their
// environment (CI or a local shell) would otherwise fail every LangGraph
// golden trace. `revision_id` is a lowercase sibling from the same merge, but
// it is too generic a name to drop wholesale — keep the prefix rule narrow.
const TRACING_ENV_METADATA_PATTERN = /^(?:LANGSMITH|LANGCHAIN)_/;

// Auth-context metadata whose PRESENCE varies by langgraph version: older
// stacks (langgraph 1.1.x era) injected langgraph_auth_user_id: "" into run
// metadata even with no auth configured; newer ones (1.2.x, pulled in by
// integrations whose dependencies need it) omit the keys entirely when there
// is no auth context. Same class of environmental noise as the tracing keys
// above — a trace recorded on either stack must match the other.
const AUTH_ENV_METADATA_KEYS = new Set([
  "langgraph_auth_user",
  "langgraph_auth_user_id",
  "langgraph_auth_permissions",
]);
const APP_CONTEXT_PREFIX = "App Context:\n";

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const GENERATED_MODEL_ID_PATTERN = /^(?:call[_-]|chatcmpl-|msg-)/;

export function isTraceEvent(value: unknown): value is TraceEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function parseDataFrame(
  data: string,
  responseBody: string,
  frameIndex: number,
): TraceEvent {
  let value: unknown;

  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new EventTraceSseParseError(
      `Invalid AG-UI SSE data frame ${frameIndex}: ${data}`,
      responseBody,
      frameIndex,
      { cause: error },
    );
  }

  if (!isTraceEvent(value)) {
    throw new EventTraceSseParseError(
      `AG-UI SSE data frame ${frameIndex} is missing a string type: ${data}`,
      responseBody,
      frameIndex,
    );
  }

  return value;
}

/** Parse the data frames from one complete AG-UI SSE response body. */
export function parseEventTraceSse(body: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let dataLines: string[] = [];
  let frameIndex = 0;

  const flushFrame = () => {
    if (dataLines.length === 0) return;

    const data = dataLines.join("\n");
    dataLines = [];
    if (data.trim().length === 0) return;

    const event = parseDataFrame(data, body, frameIndex);
    if (event.type !== "RAW") events.push(event);
    frameIndex += 1;
  };

  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "") {
      flushFrame();
      continue;
    }

    if (line === "data") {
      dataLines.push("");
      continue;
    }

    if (line.startsWith("data:")) {
      const data = line.slice(5);
      dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
    }
  }

  flushFrame();
  return events;
}

function isGeneratedIdentityField(
  key: string,
  value: string,
  path: readonly string[],
  container: object,
) {
  if (GENERATED_ID_FIELDS.has(key)) return true;
  if (key !== "id") return false;

  if (path.includes("rawEvent") && GENERATED_MODEL_ID_PATTERN.test(value)) {
    return true;
  }

  if (
    path.some(
      (segment) =>
        segment === "messages" ||
        segment === "interceptedToolCalls" ||
        segment === "toolCalls" ||
        segment === "tool_calls",
    )
  ) {
    return true;
  }

  const parent = path.at(-1);
  if (
    path.includes("rawEvent") &&
    (parent === "chunk" || parent === "output" || parent === "rawEvent")
  ) {
    return true;
  }

  const responseMetadata = Reflect.get(container, "response_metadata");
  const containerType = Reflect.get(container, "type");
  return (
    path.includes("rawEvent") &&
    ((typeof containerType === "string" &&
      LANGCHAIN_MESSAGE_TYPES.has(containerType)) ||
      (typeof responseMetadata === "object" &&
        responseMetadata !== null &&
        typeof Reflect.get(responseMetadata, "model_provider") === "string"))
  );
}

// The predicate, not an inline `typeof` chain, is what lets the callee declare
// a `Record<string, unknown>` parameter at all: reading the bag through
// `Reflect.get` hands back `any`, which satisfies any parameter type and let an
// array through unchecked, while an inline chain over `unknown` narrows only as
// far as `object` and would not typecheck at the call site.
//
// All three clauses are load-bearing at runtime, not just for narrowing:
// `typeof null === "object"`, so dropping the null check makes this accept
// `null`, and dropping the `typeof` check makes it accept a string — both of
// which `Object.entries` then reshapes or throws on.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `copilotkit_forwarded_headers` keys carry whatever spelling reached the agent.
// The producer builds the bag by matching the `x-` prefix case-insensitively and
// then emits each key verbatim, and a caller can put the key in
// `config.configurable` themselves, so nothing upstream promises lowercase. Field names are case-insensitive (RFC 9110
// §5.1), so match on the lowercased name — an upstream spelling change must not
// turn a stable trace into an environment-dependent one.
//
// An entry the map does not name keeps its spelling and its value. That set is
// open — the producer forwards every `x-` header verbatim — so an unnamed one
// carrying a per-request value (`x-request-id`, `x-amzn-trace-id`) would churn
// every golden it appears in. The remedy is to name it in
// FORWARDED_HEADER_TOKENS, not to widen the match. Two spellings of one named
// header collapse into a single entry, which is correct — they are the same
// field, and how many hops spelled it is environment metadata too.
function normalizeForwardedHeaders(
  headers: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([header, value]): [string, unknown] => {
      const lowercasedHeader = header.toLowerCase();
      const token = FORWARDED_HEADER_TOKENS.get(lowercasedHeader);
      return token === undefined ? [header, value] : [lowercasedHeader, token];
    }),
  );
}

function normalizeAppContextContent(
  value: string,
  normalizeIdentity: (value: string) => string,
) {
  if (!value.startsWith(APP_CONTEXT_PREFIX)) return value;

  let context: unknown;
  try {
    context = JSON.parse(value.slice(APP_CONTEXT_PREFIX.length));
  } catch {
    // This is ordinary message content unless it is valid App Context JSON.
    // Only the parse is guarded: a bug in the rewrite below must surface, not
    // degrade into silently unnormalized content.
    return value;
  }

  if (!isPlainRecord(context)) return value;
  let normalized = false;
  if (typeof context.thread_id === "string") {
    context.thread_id = normalizeIdentity(context.thread_id);
    normalized = true;
  }

  const headers = context.copilotkit_forwarded_headers;
  // Neither the presence nor the shape of this key is ours to assume: it is
  // absent until an `x-` header arrives, and a caller can put any JSON value
  // there. This guard keeps Object.entries from throwing or reshaping a
  // primitive/array bag. If no recognized App Context field was normalized,
  // return the original string byte-for-byte.
  if (isPlainRecord(headers)) {
    context.copilotkit_forwarded_headers = normalizeForwardedHeaders(headers);
    normalized = true;
  }

  if (!normalized) return value;
  return `${APP_CONTEXT_PREFIX}${JSON.stringify(context, null, 2)}`;
}

function mirroredModelChunk(event: TraceEvent | undefined) {
  if (event?.type !== "STATE_SNAPSHOT") return undefined;
  const rawEvent = Reflect.get(event, "rawEvent");
  if (typeof rawEvent !== "object" || rawEvent === null) return undefined;

  const streamMode = Reflect.get(rawEvent, "event");
  const data = Reflect.get(rawEvent, "data");
  let chunk: unknown;
  if (streamMode === "messages" && Array.isArray(data)) {
    chunk = data[0];
  } else if (streamMode === "events" && typeof data === "object" && data) {
    if (Reflect.get(data, "event") !== "on_chat_model_stream") {
      return undefined;
    }
    const eventData = Reflect.get(data, "data");
    if (typeof eventData === "object" && eventData) {
      chunk = Reflect.get(eventData, "chunk");
    }
  }

  if (typeof chunk !== "object" || chunk === null) return undefined;
  const chunkId = Reflect.get(chunk, "id");
  return typeof chunkId === "string"
    ? { streamMode, chunkId, chunk }
    : undefined;
}

function stabilizeMirroredModelChunks(events: TraceEvent[]) {
  const mirrors = events.map(mirroredModelChunk);
  const redundantMessageIndexes = new Set<number>();
  const consumedEventIndexes = new Set<number>();

  for (let index = 0; index < events.length; index += 1) {
    const messageMirror = mirrors[index];
    if (messageMirror?.streamMode !== "messages") continue;

    const matchingEventIndex = mirrors.findIndex(
      (eventMirror, candidateIndex) =>
        candidateIndex !== index &&
        !consumedEventIndexes.has(candidateIndex) &&
        eventMirror?.streamMode === "events" &&
        eventMirror.chunkId === messageMirror.chunkId &&
        isDeepStrictEqual(eventMirror.chunk, messageMirror.chunk) &&
        isDeepStrictEqual(
          Reflect.get(events[candidateIndex], "snapshot"),
          Reflect.get(events[index], "snapshot"),
        ),
    );

    if (matchingEventIndex !== -1) {
      redundantMessageIndexes.add(index);
      consumedEventIndexes.add(matchingEventIndex);
    }
  }

  const deduplicated = events.filter(
    (_, index) => !redundantMessageIndexes.has(index),
  );
  const stabilized: TraceEvent[] = [];

  for (let index = 0; index < deduplicated.length; index += 1) {
    const first = mirroredModelChunk(deduplicated[index]);
    const second = mirroredModelChunk(deduplicated[index + 1]);

    const isMirrorPair =
      first !== undefined &&
      second !== undefined &&
      first.streamMode !== second.streamMode &&
      first.chunkId === second.chunkId;

    if (
      isMirrorPair &&
      first.streamMode === "events" &&
      second.streamMode === "messages"
    ) {
      stabilized.push(deduplicated[index + 1], deduplicated[index]);
      index += 1;
      continue;
    }

    stabilized.push(deduplicated[index]);
  }

  return stabilized;
}

/**
 * Remove unstable transport metadata and replace generated identities with stable,
 * first-seen tokens while retaining references between events.
 */
export function normalizeEventTrace(
  events: readonly TraceEvent[],
): TraceEvent[] {
  const identities = new Map<string, string>();

  const normalizeIdentity = (value: string) => {
    const existing = identities.get(value);
    if (existing) return existing;

    const token = `id-${identities.size + 1}`;
    identities.set(value, token);
    return token;
  };

  const normalizeStructuredIdentity = (value: string) => {
    return value.replace(UUID_PATTERN, (uuid) =>
      normalizeIdentity(uuid.toLowerCase()),
    );
  };

  const normalizeValue = (value: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item, path));
    }

    if (typeof value !== "object" || value === null) return value;

    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => {
        if (key === "timestamp" && path.length === 0) return [];
        if (TRACING_ENV_METADATA_PATTERN.test(key)) return [];
        if (AUTH_ENV_METADATA_KEYS.has(key)) return [];
        if (
          key === "lc_versions" &&
          path.at(-1) === "metadata" &&
          path.includes("rawEvent")
        ) {
          return [];
        }
        if (
          key === "created_at" &&
          path.at(-1) === "response_metadata" &&
          (path.includes("rawEvent") ||
            typeof Reflect.get(value, "model_provider") === "string")
        ) {
          return [];
        }

        const nextPath = [...path, key];
        let normalized: unknown;
        if (Array.isArray(child) && GENERATED_ID_ARRAY_FIELDS.has(key)) {
          normalized = child.map((identity) =>
            typeof identity === "string"
              ? normalizeIdentity(identity)
              : normalizeValue(identity, nextPath),
          );
        } else if (typeof child !== "string") {
          normalized = normalizeValue(child, nextPath);
        } else if (STRUCTURED_ID_FIELDS.has(key)) {
          normalized = normalizeStructuredIdentity(child);
        } else if (isGeneratedIdentityField(key, child, path, value)) {
          normalized = normalizeIdentity(child);
        } else if (ENVIRONMENT_VALUE_TOKENS.has(key)) {
          normalized = ENVIRONMENT_VALUE_TOKENS.get(key);
        } else if (key === "content") {
          normalized = normalizeAppContextContent(child, normalizeIdentity);
        } else {
          normalized = child;
        }

        return [[key, normalized]];
      }),
    );
  };

  return stabilizeMirroredModelChunks([...events]).map((event) => {
    const normalized = normalizeValue(event, []);
    if (!isTraceEvent(normalized)) {
      throw new Error("Normalized AG-UI event lost its type");
    }
    return normalized;
  });
}
