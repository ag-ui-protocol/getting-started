/** Configuration primitives for customizing Strands agent behavior. */

import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import type { AgentConfig, SessionManager } from "@strands-agents/sdk";
import type { A2UIInjectConfig } from "./a2ui-tool";

import type { Logger } from "./logger";
import type { UrlFetchPolicy } from "./utils";

export type StatePayload = Record<string, unknown>;

/**
 * Free-form key/value map carried on `RunAgentInput.context[]` and
 * `RunAgentInput.forwardedProps`. Exposed on hook contexts so behaviors can
 * react to e.g. per-request auth tokens or locale without re-parsing
 * `inputData`.
 *
 * TypeScript-only: the Python adapter passes `input_data` directly to hooks
 * and callers pull these fields off themselves.
 */
export interface ToolCallContextExtras {
  /**
   * `RunAgentInput.context[]` flattened by `description` → `value`.
   * Duplicates: later entries overwrite earlier ones. Keys `__proto__`,
   * `constructor`, and `prototype` are dropped to prevent prototype-pollution
   * surprises in downstream `Object.assign(target, ctx.context)` usage.
   */
  context: Readonly<Record<string, string>>;
  /**
   * `RunAgentInput.forwardedProps` as an opaque record. Shape is defined by
   * the frontend; the adapter does not introspect it.
   */
  forwardedProps: Readonly<Record<string, unknown>>;
}

/** Context passed to tool call hooks. */
export interface ToolCallContext extends ToolCallContextExtras {
  inputData: RunAgentInput;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  argsStr: string;
}

/** Context passed to tool result hooks. */
export interface ToolResultContext extends ToolCallContext {
  resultData: unknown;
  messageId: string;
}

export type MaybePromise<T> = T | Promise<T>;

export type ArgsStreamer = (ctx: ToolCallContext) => AsyncIterable<string>;
export type StateFromArgs = (
  ctx: ToolCallContext,
) => MaybePromise<StatePayload | null | undefined>;
export type StateFromResult = (
  ctx: ToolResultContext,
) => MaybePromise<StatePayload | null | undefined>;
export type CustomResultHandler = (
  ctx: ToolResultContext,
) => AsyncIterable<BaseEvent | null | undefined>;
export type StateContextBuilder = (
  inputData: RunAgentInput,
  prompt: string,
  /** Convenience view over `inputData.context[]` + `inputData.forwardedProps`. */
  extras?: ToolCallContextExtras,
) => string;
export type SessionManagerProvider = (
  inputData: RunAgentInput,
) => MaybePromise<SessionManager | null | undefined>;

/** Declarative mapping telling the UI how to predict state from tool args. */
export interface PredictStateMapping {
  stateKey: string;
  tool: string;
  toolArgument: string;
}

export function predictStateMappingToPayload(m: PredictStateMapping): {
  state_key: string;
  tool: string;
  tool_argument: string;
} {
  return {
    state_key: m.stateKey,
    tool: m.tool,
    tool_argument: m.toolArgument,
  };
}

/** Context passed to toolStreamEventHandler hooks. */
export interface ToolStreamEventContext {
  toolUseId: string;
  toolName: string;
  streamData: unknown;
}

/** Handler for mid-execution tool stream events. Must return an async iterable. */
export type ToolStreamEventHandler = (
  ctx: ToolStreamEventContext,
) => AsyncIterable<BaseEvent | null | undefined>;

/** Declarative configuration for tool-specific handling. */
export interface ToolBehavior {
  /**
   * Suppress the `MessagesSnapshotEvent` that would normally follow this
   * tool's `TOOL_CALL_END` / `TOOL_CALL_RESULT`. Useful when
   * `customResultHandler` emits its own snapshot.
   */
  skipMessagesSnapshot?: boolean;
  /** Keep the stream alive after emitting a frontend tool call. */
  continueAfterFrontendCall?: boolean;
  /** Close text streaming and halt the agent after a tool result arrives. */
  stopStreamingAfterResult?: boolean;
  /** `PredictStateMapping[]` that inform the UI how to project tool args into state. */
  predictState?: PredictStateMapping | Iterable<PredictStateMapping>;
  /** Async generator controlling how tool arguments are streamed to the frontend. */
  argsStreamer?: ArgsStreamer;
  /** Derive a `StateSnapshotEvent` from the tool call arguments. */
  stateFromArgs?: StateFromArgs;
  /** Derive a `StateSnapshotEvent` from the tool result. */
  stateFromResult?: StateFromResult;
  /** Async iterator that can emit arbitrary AG-UI events in response to a result. */
  customResultHandler?: CustomResultHandler;
  /**
   * Interrupt before a server-executed tool runs, requiring human approval.
   * Client-provided tools should gate execution in the client.
   */
  interruptOnCall?: boolean;
  /** Custom handler for mid-execution tool stream events. Suppresses default state snapshot behavior. */
  toolStreamEventHandler?: ToolStreamEventHandler;
}

/**
 * Builds extra `AgentConfig` for one thread's agent.
 *
 * See {@link StrandsAgentConfig.threadAgentConfig}.
 */
export type ThreadAgentConfigProvider = (
  input: RunAgentInput,
) => Partial<AgentConfig> | Promise<Partial<AgentConfig>>;

/** Top-level configuration for the Strands agent adapter. */
export interface StrandsAgentConfig {
  /** Per-tool overrides keyed by the Strands tool name. */
  toolBehaviors?: Record<string, ToolBehavior>;
  /** Callable that enriches the outgoing prompt with the current shared state. */
  stateContextBuilder?: StateContextBuilder;
  /**
   * Optional factory for creating per-thread `SessionManager` instances.
   *
   * Called exactly once per `threadId` the first time that thread is seen.
   * Subsequent requests on the same thread reuse the cached agent (and its
   * SessionManager). If the provider depends on per-request data (e.g. auth
   * tokens in `forwardedProps`), only the first request's data is used.
   *
   * If the provider throws, the run yields `RUN_ERROR` and returns early;
   * the thread is NOT cached so the provider will be retried on the next
   * request.
   *
   * If the provider returns `null` or `undefined`, a warning is logged and
   * the agent runs without session persistence; the thread IS cached.
   */
  sessionManagerProvider?: SessionManagerProvider;
  /**
   * Extra `AgentConfig` for each per-thread agent, merged over whatever was
   * recovered from the template.
   *
   * The adapter builds one Strands `Agent` per thread from the template it was
   * given, by reading the template's settings back off the built instance.
   * Some settings cannot be read back at all: Strands consumes them into
   * internal state during construction and keeps nothing under a name the
   * adapter can find. `retryStrategy`, `traceAttributes` and `contextManager`
   * are the current examples. Others are readable but belong to the agent that
   * owns them, so handing the same instance to every thread would let one
   * conversation disturb another.
   *
   * Either way the template is the wrong place to put them, and no amount of
   * reflection over a built `Agent` recovers them. This hook is the supported
   * route: it runs once per `threadId`, and whatever it returns is applied over
   * the recovered fields, so a caller can set anything the adapter cannot carry
   * and can override anything it can.
   *
   * Three fields are re-asserted by the adapter afterwards, because they are
   * what keeps threads apart and a run coherent: the `SessionManager` from
   * `sessionManagerProvider`, the seeded `messages` for a cold thread, and
   * `printer`, which stays off because the adapter streams the run itself.
   *
   * Called with the same `RunAgentInput` that created the thread. If it throws,
   * the run yields `RUN_ERROR` and the thread is not cached, so the next
   * request retries it.
   *
   * @example
   * ```ts
   * new StrandsAgent({
   *   agent: template,
   *   name: "assistant",
   *   config: {
   *     // Retries disabled, and a fresh context manager per conversation.
   *     threadAgentConfig: () => ({
   *       retryStrategy: null,
   *       contextManager: "auto",
   *     }),
   *   },
   * })
   * ```
   */
  threadAgentConfig?: ThreadAgentConfigProvider;
  /**
   * Emit `MessagesSnapshotEvent` at lifecycle boundaries (after the initial
   * `STATE_SNAPSHOT`, after each `TOOL_CALL_END` / `TOOL_CALL_RESULT`, and
   * after each terminal `TEXT_MESSAGE_END`).
   *
   * Required for CopilotKit v2 frontends; set to `false` for raw AG-UI
   * consumers that reconstruct messages themselves. Default: `true`.
   */
  emitMessagesSnapshot?: boolean;
  /**
   * When `true` (and the cached Strands agent has no `sessionManager`, and the
   * run submitted no `resume[]`), reconcile the per-thread `Agent.messages`
   * list with `RunAgentInput.messages` before invoking `stream()`. Python's
   * `replay_history` carves out a resume the same way.
   *
   * Prevents the LLM from re-firing frontend tools every turn because
   * Strands' internal history was missing the tool result the frontend
   * produced. Disable only if you manage Strands history yourself.
   * Default: `true`.
   *
   * Scoped to that replay alone. When a `sessionManager` is wired it owns
   * history, and correcting the placeholder `toolResult` the adapter persisted
   * for a frontend call is not something a caller can do in its place, so that
   * correction runs whatever this is set to. Python's gate is a disjunction:
   * this flag governs one arm, and the other reconciles on a resume carrying
   * parked proxy placeholders whatever the flag is set to. So the two adapters
   * differ only on the ordinary non-resume continuation, deliberately.
   */
  replayHistoryIntoStrands?: boolean;
  /**
   * Emit the self-expanding AG-UI chunk events (`TEXT_MESSAGE_CHUNK`,
   * `TOOL_CALL_CHUNK`, `REASONING_MESSAGE_CHUNK`) instead of the explicit
   * `*_START` / `*_CONTENT` / `*_END` triples. Halves the event count on
   * high-frequency deltas; useful for bandwidth-constrained transports.
   * TypeScript-only. Default: `false`.
   */
  emitChunkEvents?: boolean;
  /**
   * A2UI auto-injection config — everything A2UI-related in one place.
   * When the CopilotKit runtime forwards `injectA2UITool` (or `a2ui.injectA2UITool`
   * opts in on a host that doesn't), the adapter injects a `generate_a2ui`
   * recovery tool and infers the model from the wrapped agent — no manual
   * `getA2UITools()` needed. Knobs:
   *   - `injectA2UITool` — opt in without the runtime flag; a string also names
   *     the injected render tool to drop.
   *   - `defaultCatalogId` — catalog id stamped into auto-injected surfaces
   *     (must match the host renderer's catalog).
   *   - `guidelines.compositionGuide` — teaches the sub-agent the catalog's
   *     components; required for a real model to compose them.
   *   - `catalog` — inline catalog for catalog-aware (semantic) recovery.
   *   - `recovery` — attempt cap / retry-UI threshold.
   *   - `toolDescription` sets the description advertised to the planner,
   *     steering when it reaches for `generate_a2ui`.
   *   - `defaultSurfaceId` is stamped when the sub-agent omits a surface id.
   *   - `onA2UIAttempt` is a per-attempt recovery hook for host status/traces.
   */
  a2ui?: A2UIInjectConfig;
  /**
   * Optional injectable logger. Mirrors the Python adapter's
   * `logging.getLogger("ag_ui_strands")`: the default surfaces `warn` / `error`
   * via the `console` and drops `debug`, matching Python's stdlib default
   * (WARNING-and-up to stderr). Pass `{ debug: console.debug, warn:
   * console.warn, error: console.error }` to enable verbose traces, `{ debug()
   * {}, warn() {}, error() {} }` to silence everything, or wire in pino /
   * winston / bunyan directly — the `Logger` shape matches the `console`
   * methods.
   *
   * Debug messages match the Python adapter's message strings field-for-field
   * (modulo camelCase / snake_case) so cross-SDK log diffs are straightforward.
   */
  logger?: Logger;
  /**
   * The policy applied to every server-side fetch of a URL content source.
   *
   * A user message may carry an image, document, video or audio clip as a URL
   * instead of inline data, and the adapter fetches it, so the fetch runs
   * with the server's own network reach rather than the client's. Anyone who
   * can post a `RunAgentInput` can name the URL.
   *
   * `undefined` uses `DEFAULT_URL_FETCH_POLICY`, which fetches only `http`
   * and `https`, refuses any host that resolves outside the public internet
   * (loopback, private, link-local, multicast, reserved, unspecified,
   * including the cloud metadata endpoints), pins the connection to the
   * address it validated so a second DNS answer cannot move it, re-checks
   * every redirect hop under this same policy, refuses a redirect that drops
   * TLS, and caps one attachment's size and the time it may take.
   *
   * Private-network access is opt-in and is the host's decision, never the
   * client's. A deployment whose attachments live on a private CDN or behind
   * split DNS spreads the opt-in over the default:
   *
   * ```ts
   * import { DEFAULT_URL_FETCH_POLICY } from "@ag-ui/aws-strands";
   *
   * config: {
   *   urlFetchPolicy: {
   *     ...DEFAULT_URL_FETCH_POLICY,
   *     allowPrivateNetworks: true,
   *   },
   * }
   * ```
   *
   * Link-local addresses and the cloud metadata endpoints stay blocked even
   * under that opt-in. `allowedSchemes` can only be narrowed, never widened:
   * an http/https request is issued through a transport pinned to the
   * addresses that passed validation, and any other scheme would go through a
   * client that resolves the host again at connection time, reopening the
   * rebinding window this policy exists to close. Narrow it with
   * `allowedSchemes: new Set(["https"])`.
   *
   * An unusable policy (a limit below one, a fractional redirect cap, a
   * scheme outside http/https, a non-boolean `allowPrivateNetworks`) fails
   * the run with `RUN_ERROR { code: "URL_FETCH_POLICY_INVALID" }` before any
   * attachment is fetched. It never silently reverts to the default.
   *
   * Python's `url_fetch_policy` is the same option, and the two policies do
   * not carry quite the same fields: Python adds a run-wide attachment,
   * byte and time budget, and TypeScript adds `maxRedirects` and
   * `nat64Prefixes`. That divergence predates this option being configurable
   * at all.
   */
  urlFetchPolicy?: UrlFetchPolicy;
}

// Prototype-pollution guard for keys flattened from `context[]`. Plain
// `Object.create(null)` maps have no prototype chain, so `__proto__` becomes
// a regular string key; `constructor` and `prototype` are likewise unfiltered.
const UNSAFE_CONTEXT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPredictStateMapping(v: unknown): v is PredictStateMapping {
  return (
    typeof v === "object" &&
    v !== null &&
    "stateKey" in v &&
    "tool" in v &&
    "toolArgument" in v
  );
}

/**
 * Flatten `RunAgentInput.context[]` into a plain key/value record and ensure
 * `forwardedProps` is a record. Exported so hook implementations can call it
 * when they have an `inputData` but not a fully-populated hook context.
 */
export function buildContextExtras(
  inputData: RunAgentInput,
): ToolCallContextExtras {
  const context = Object.create(null) as Record<string, string>;
  const rawContext = (inputData as { context?: unknown }).context;
  if (Array.isArray(rawContext)) {
    for (const entry of rawContext) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { description?: unknown; value?: unknown };
      if (typeof e.description !== "string" || e.description.length === 0)
        continue;
      if (UNSAFE_CONTEXT_KEYS.has(e.description)) continue;
      context[e.description] =
        typeof e.value === "string" ? e.value : String(e.value ?? "");
    }
  }
  const rawForwarded = (inputData as { forwardedProps?: unknown })
    .forwardedProps;
  const forwardedProps: Record<string, unknown> =
    rawForwarded &&
    typeof rawForwarded === "object" &&
    !Array.isArray(rawForwarded)
      ? (rawForwarded as Record<string, unknown>)
      : {};
  return { context, forwardedProps };
}

/** Resolve promise-like values produced by hook callables. */
export async function maybeAwait<T>(value: MaybePromise<T>): Promise<T> {
  return await Promise.resolve(value);
}

/** Normalize predict-state config into a concrete list. */
export function normalizePredictState(
  value: PredictStateMapping | Iterable<PredictStateMapping> | undefined,
): PredictStateMapping[] {
  if (value === undefined) return [];
  if (isPredictStateMapping(value)) return [value];
  return Array.from(value);
}
