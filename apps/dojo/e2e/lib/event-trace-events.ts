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
  "parent_run_id",
  "run_id",
  "requestId",
  "thread_id",
  "tool_call_id",
]);

const STRUCTURED_ID_FIELDS = new Set([
  "checkpoint_ns",
  "langgraph_checkpoint_ns",
]);

const GENERATED_ID_ARRAY_FIELDS = new Set(["parentIds", "parent_ids"]);
const LANGCHAIN_MESSAGE_TYPES = new Set([
  "ai",
  "human",
  "system",
  "tool",
  "function",
]);
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
const APP_CONTEXT_PREFIX = "App Context:\n";

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

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
  path: readonly string[],
  container: object,
) {
  if (GENERATED_ID_FIELDS.has(key)) return true;
  if (key !== "id") return false;

  if (
    path.some(
      (segment) =>
        segment === "messages" ||
        segment === "toolCalls" ||
        segment === "tool_calls",
    )
  ) {
    return true;
  }

  const parent = path.at(-1);
  if (
    path.includes("rawEvent") &&
    (parent === "chunk" || parent === "output")
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

function normalizeAppContextContent(value: string) {
  if (!value.startsWith(APP_CONTEXT_PREFIX)) return value;

  try {
    const context: unknown = JSON.parse(value.slice(APP_CONTEXT_PREFIX.length));
    if (typeof context !== "object" || context === null) return value;
    const headers = Reflect.get(context, "copilotkit_forwarded_headers");
    if (typeof headers !== "object" || headers === null) return value;

    for (const [header, token] of FORWARDED_HEADER_TOKENS) {
      if (Object.hasOwn(headers, header)) Reflect.set(headers, header, token);
    }
    return `${APP_CONTEXT_PREFIX}${JSON.stringify(context, null, 2)}`;
  } catch {
    // This is ordinary message content unless it is valid App Context JSON.
    return value;
  }
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
        } else if (isGeneratedIdentityField(key, path, value)) {
          normalized = normalizeIdentity(child);
        } else if (ENVIRONMENT_VALUE_TOKENS.has(key)) {
          normalized = ENVIRONMENT_VALUE_TOKENS.get(key);
        } else if (key === "content") {
          normalized = normalizeAppContextContent(child);
        } else {
          normalized = child;
        }

        return [[key, normalized]];
      }),
    );
  };

  return events.map((event) => {
    const normalized = normalizeValue(event, []);
    if (!isTraceEvent(normalized)) {
      throw new Error("Normalized AG-UI event lost its type");
    }
    return normalized;
  });
}
