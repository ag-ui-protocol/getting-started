/**
 * AWS Strands Agent adapter for AG-UI.
 *
 * Translates Strands streaming events into the AG-UI event protocol.
 */

import { createHash, randomUUID } from "crypto";

import {
  Agent as StrandsAgentCore,
  AfterToolsEvent,
  BeforeToolCallEvent,
  InterruptResponseContent,
  Message as StrandsMessage,
  SessionManager,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  type AgentConfig,
  type AgentResult as StrandsAgentResult,
  type AgentStreamEvent,
  type ContentBlock,
  type Interrupt as StrandsInterrupt,
  type JSONValue,
  type Plugin,
} from "@strands-agents/sdk";
import {
  EventType,
  aggregateTokenUsage,
  type AssistantMessage as AguiAssistantMessage,
  type BaseEvent,
  type Interrupt as AguiInterrupt,
  type Message as AguiMessage,
  type ResumeEntry,
  type RunAgentInput,
  type TokenUsage,
  type ToolCall as AguiToolCall,
  type ToolMessage as AguiToolMessage,
  type UserMessage as AguiUserMessage,
} from "@ag-ui/core";
import { InterruptSchema as AguiInterruptSchema } from "@ag-ui/core/schemas";

import {
  buildContextExtras,
  maybeAwait,
  normalizePredictState,
  predictStateMappingToPayload,
  type StrandsAgentConfig,
  type ToolCallContext,
  type ToolResultContext,
} from "./config";
import {
  CitationAccumulator,
  citationMetadata,
  copyCitationMetadata,
  discardOrphanCitations,
  jsonRoundTrip,
} from "./citations";
import { isProxyTool, syncProxyTools } from "./client-proxy-tool";
import {
  applyTemplateToolSelection,
  indexTemplateTools,
  parkedBatchToolNames,
  recordTemplateToolSelection,
  renarrowTemplateTools,
  resolveTemplateToolSelection,
} from "./template-tools";
import type { TemplateToolSelection } from "./template-tools";
import {
  planA2UIInjection,
  isAutoInjectedA2UITool,
  withoutA2UIRenderGuides,
  A2UI_STREAM_KEY,
} from "./a2ui-tool";
import {
  ensureTransientContextHook,
  formatAguiContext,
  installOrchestratorContextHooks,
  normalizeAguiContext,
  pullWithModelContext,
  restoreOrchestratorContext,
  restoreTransientModelContext,
} from "./model-context";
import {
  _buildToolResultContent,
  _coerceText,
  assertUsablePolicy,
  convertAguiContentToStrands,
  convertAguiContentToStrandsDetailed,
  createUrlFetchCache,
  flattenContentToText,
  type DroppedMedia,
  type MediaConversionOptions,
} from "./utils";
import type { SeenToolCall } from "./types";
import {
  activeProxyPlaceholderIds,
  clientResultFields,
  proxyPlaceholderProvenanceIds,
  recordFrontendCallId,
  recordedFrontendCallIds,
  reconcileFrontendToolResults,
  supportsSnapshotReconciliation,
  uncorrectableProxyPlaceholderIds,
} from "./session-reconcile";
import type { PendingFrontendResult } from "./session-reconcile";
import { DEFAULT_LOGGER, resolveLogger, type Logger } from "./logger";
import {
  strandsModelIdentity,
  tokenUsageFromStrandsUsage,
  type StrandsModelIdentity,
} from "./token-usage";

// `_buildToolResultContent` lives in ./utils so reconciliation can build the
// same content without importing this module, which would be a cycle. This
// stays its established import path.
export { _buildToolResultContent };

const LOG_PREFIX = "[@ag-ui/aws-strands]";

/**
 * Marks a RUN_FINISHED that reports success while the run's agent stays parked
 * with nothing to hand the client. `run()` reads it to decide whether the
 * resume may be remembered as completed.
 *
 * Carried on the event rather than in per-thread state so that it belongs to
 * exactly one run by construction. Per-thread state cannot: the pause is
 * recorded while the run holds its thread and acted on after it lets go, so
 * another run starting in between could consume a record whose owner had not
 * read it yet.
 *
 * A unique symbol, not a registry one, so no other code can mint this key by
 * name. `JSON.stringify` drops symbol keys, so it never reaches the wire.
 */
const PAUSED_PARKED = Symbol("agui.strands.pausedWhileParked");

// Strands' `randomUUID` return type is branded; normalise to plain string.
const uuid = (): string => randomUUID();

/**
 * Terminal error code and fallback message for a forced stop.
 *
 * Both are matched literally by clients and by mock harnesses against the
 * Python adapter's `RUN_ERROR`, so the two bridges spell them identically.
 * Changing either here is a wire-contract change.
 */
const FORCE_STOP_ERROR_CODE = "STRANDS_FORCE_STOP";

/**
 * Assistant text Strands appends when the adapter ends the turn on a frontend
 * tool call. `AfterToolsEvent.endTurn` always appends one, so the adapter picks
 * the content and drops that message again before the turn is persisted: the
 * client is mid-round-trip on the tool, and a trailing assistant turn would be
 * replayed to the model as a message to continue.
 */
const FRONTEND_HALT_TURN_TEXT = "Awaiting the client's tool result.";
const FORCE_STOP_FALLBACK_MESSAGE = "The Strands agent stopped unexpectedly.";

/**
 * Abnormal terminal stop reasons, keyed by what the SDK reports and valued with
 * the provider spelling the Python adapter puts on the wire.
 *
 * The TS SDK canonicalises provider stop reasons to camelCase (see
 * `dist/src/models/bedrock.js`, which maps Bedrock's `content_filtered` to
 * `contentFiltered`); Python forwards the provider spelling untouched. The
 * hint event carries Python's spelling from both bridges so a client matches
 * one value, not one per language. `StopReason` widens to `string`, so a model
 * that hands the provider value straight through is keyed here too.
 *
 * A `Map` and not an object literal, because the key arrives from the provider:
 * an object literal answers `toString` / `constructor` / `valueOf` /
 * `__proto__` off `Object.prototype`, and an inherited function passes a
 * truthiness guard and puts a `stop_reason` that is not a stop reason on the
 * wire.
 *
 * `maxTokens` stays keyed so this is a literal mirror of Python's tuple, which
 * lists `max_tokens`. The entry is dead on both bridges for the same reason:
 * the layer under the adapter raises before a token-limit truncation can reach
 * a terminal result (`MaxTokensError` from `Model.streamAggregated` here,
 * `MaxTokensReachedException` from `event_loop` there).
 *
 * Any reason absent from the table carries no hint. That covers the normal
 * `endTurn` and `toolUse`, the other stops Python's tuple has no entry for
 * (`cancelled`, `stopSequence`, `interrupt` and `modelContextWindowExceeded`,
 * the last of which Python's own `StopReason` does not spell at all) and a
 * provider value forwarded untranslated such as Anthropic's `refusal`.
 * Mirroring runs one way: where Python has no counterpart value, this stays
 * silent rather than inventing one.
 */
const ABNORMAL_STOP_REASONS = new Map<string, string>([
  ["maxTokens", "max_tokens"],
  ["max_tokens", "max_tokens"],
  ["guardrailIntervened", "guardrail_intervened"],
  ["guardrail_intervened", "guardrail_intervened"],
  ["contentFiltered", "content_filtered"],
  ["content_filtered", "content_filtered"],
]);

/**
 * SDK error names that must not be reported as a forced stop, keyed by
 * `Error.name`.
 *
 * Python does not split this by exception type but by WHERE the exception was
 * raised. On `strands-agents` 1.52.0, the release this taxonomy was verified
 * against, `_handle_model_execution` yields `ForceStopEvent` for anything that
 * escapes the model call itself once no hook has asked for a retry, so a
 * provider failure raised inside that call reports as a forced stop. The two
 * raises that happen AFTER the model call returned normally,
 * `MaxTokensReachedException` and `StructuredOutputException`, are re-raised by
 * `event_loop_cycle` without a `ForceStopEvent` and reach the Python adapter's
 * outer handler, which reports `STRANDS_ERROR`. These are those two TS
 * analogues, rethrown so they reach this adapter's outer handler and keep the
 * same code.
 *
 * That first sentence is a statement about 1.52.0 and not about every release
 * the Python sibling supports. On 1.15.0, 1.18.0 (what its `uv.lock` pins) and
 * 1.20.0 the same `except` is gated behind an exhausted
 * `ModelThrottledException`, and every other exception is re-raised with no
 * `ForceStopEvent` at all, so a provider 5xx reports `STRANDS_ERROR` there
 * while it reports `STRANDS_FORCE_STOP` here. This adapter carries no version
 * branching for that and is not going to: it mirrors current Python. See
 * `ARCHITECTURE.md` for the releases that were driven to establish it.
 *
 * `ContextWindowOverflowError` is deliberately absent even though Python lists
 * `ContextWindowOverflowException` in the same re-raise tuple: providers raise
 * it from inside the model call, where the force-stop handler catches it first.
 * The TS SDK raises its counterpart from the provider too (`bedrock.js`,
 * `anthropic.js` and `google/model.js` all raise it while translating a
 * model-call failure), so the forced-stop default is the matching report.
 *
 * Matched on `name`, which the SDK sets explicitly in every constructor
 * (`dist/src/errors.js`), rather than by `instanceof`: name matching survives a
 * duplicated SDK copy in the dependency tree and needs no value import of a
 * peer dependency. Never on a version string.
 */
const STREAM_ERROR_BYPASS_NAMES = new Set<string>([
  "MaxTokensError",
  "StructuredOutputError",
]);

/**
 * `Error.name` when the thrown value carries a string one, else `undefined`.
 *
 * Total for every thrown value, for the same reason `_forceStopMessage` is.
 * Inside `ForcedStop.record` it runs before anything is latched, so a throw
 * escaping here would leave the outer handler reporting a provider failure as
 * `ADAPTER_BUG`; it also runs inside `_isFrontendHaltSentinel`, where a throw
 * would do the same from the frontend-halt window. Reading `name` can itself
 * throw, from a getter that raises or from a `Proxy` whose `get` trap does. A
 * name that cannot be read is treated as an absent one, which is the reading a
 * value carrying no name already gets.
 */
function _errorName(e: unknown): string | undefined {
  try {
    const name = (e as { name?: unknown } | null | undefined)?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the thrown value carries a `cause`.
 *
 * Total for every thrown value, for the same reason `_errorName` is: reading
 * `cause` can throw from a getter or a `Proxy` trap, and it is read inside the
 * frontend-halt window, where an escaping throw reports a provider failure as
 * `ADAPTER_BUG` and skips the closeout.
 *
 * An unreadable `cause` counts as PRESENT rather than absent, which is the
 * opposite of how `_errorName` treats an unreadable name, and deliberately so:
 * an absent `cause` is what identifies the halt sentinel, and the sentinel is
 * SWALLOWED. Reading "cannot tell" as "absent" would turn a provider failure
 * into a finished run. Reading it as "present" only costs a run that really
 * did halt an extra `RUN_ERROR` it would not otherwise have had.
 */
function _carriesCause(e: unknown): boolean {
  try {
    return (e as { cause?: unknown } | null | undefined)?.cause !== undefined;
  } catch {
    return true;
  }
}

/**
 * The wire message for a forced stop, derived from whatever was thrown.
 *
 * A throw carries no contract in JavaScript, so this is the one place that
 * decides what a client reads. `null` and `undefined` are the two values whose
 * `String()` form is a plausible-looking message that says nothing about the
 * failure ("null", "undefined"), so they take the fallback the same way an
 * empty message does. Every other value keeps its own text, including the
 * string `"null"`, which is a message someone wrote.
 *
 * Python cannot reach this case at all: `raise None` is a TypeError there and
 * its `force_stop_reason` is always `str(exception)`, so treating a thrown
 * `null` as "no reason given" adds no cross-language wire difference.
 *
 * Total for every thrown value. Deriving the text can itself throw: `String()`
 * on an object with a null prototype finds no `toString` to call, and an
 * `Error` whose `message` is not a string has no `trim`. A throw escaping here
 * would reach the outer handler and report a provider failure as `ADAPTER_BUG`,
 * so a value whose text cannot be read takes the same fallback as an absent
 * one.
 */
function _forceStopMessage(e: unknown): string {
  if (e === null || e === undefined) return FORCE_STOP_FALLBACK_MESSAGE;
  try {
    return _errorMessage(e).trim() || FORCE_STOP_FALLBACK_MESSAGE;
  } catch {
    return FORCE_STOP_FALLBACK_MESSAGE;
  }
}

/**
 * True for the throw Strands uses to report a cycle that halted before the
 * model produced a final assistant message.
 *
 * `Model.streamAggregated` raises a bare `ModelError` with no `cause` for that
 * ("Stream ended without completing a message"), and it is the only throw the
 * frontend-halt window may treat as expected flow. Everything else in that
 * window is a real failure and has to stay visible:
 *   - a dedicated SDK error carries its own `name` (`ModelThrottledError`,
 *     `MaxTokensError`, `ContextWindowOverflowError`, ...);
 *   - a provider failure re-raised by that same method arrives as `ModelError`
 *     with the original error on `cause`, which the halt throw never carries.
 *
 * Deliberately not a check on the message text. `stop-reasons.test.ts` drives
 * both directions a naive match gets wrong: a wrapped provider failure whose
 * message happens to read like the sentinel is still reported, and a sentinel
 * the SDK reworded is still swallowed. So a reworded SDK string cannot
 * silently reopen the hole. A plain `Error` with no `cause` counts as the
 * sentinel too, which keeps the lenient reading this window has always had for
 * a throw that carries no taxonomy at all. A `ModelError` raised with neither a
 * `cause` nor a distinguishing name (the Vercel provider has one such site) is
 * indistinguishable from the sentinel by any means short of the message text,
 * and is still swallowed here.
 */
function _isFrontendHaltSentinel(e: unknown): boolean {
  const name = _errorName(e);
  if (name !== "ModelError" && name !== "Error") return false;
  return !_carriesCause(e);
}

/**
 * The `stepName` for a node's STEP_STARTED / STEP_FINISHED pair.
 *
 * One function because the two events must spell it identically for a frontend
 * to pair them (events.mdx §StepFinished), and both run paths emit both.
 */
function _stepName(ev: { nodeId?: string; nodeType?: string }): string {
  return `${ev.nodeType ?? "agent"}:${ev.nodeId ?? "unknown"}`;
}

/** Hint event for a non-normal stop. Same name and payload shape as Python. */
function _agentStopped(stopReason: string): BaseEvent {
  return {
    type: EventType.CUSTOM,
    name: "AgentStopped",
    value: { stop_reason: stopReason },
  } as BaseEvent;
}

/**
 * The single-agent path's terminal-failure report, mirroring Python's
 * `force_stop` handling.
 *
 * `_runSingleAgent` is the only user, deliberately. The orchestrator path does
 * NOT report a forced stop: `Node.stream` turns a node's provider failure into
 * a FAILED `NodeResult` instead of a throw, so the only exceptions that escape
 * a real `Graph` or `Swarm` are orchestration budget violations, which are not
 * model stop reasons. That path keeps its outer handler's `STRANDS_ERROR`; see
 * the comment on the stream in `_runOrchestrator`.
 *
 * What the two paths DO share is the abnormal-stop hint, which reads one
 * `ABNORMAL_STOP_REASONS` table from both and reaches the wire identically on
 * a real Graph.
 *
 * `label` is parameterised so the log line names the failing stream. The
 * message closeout stays with the caller: the single-agent path closes
 * reasoning before text, drains pending tool calls and appends to a messages
 * snapshot.
 */
class ForcedStop {
  /** Reason to report, once a failure has been recorded. */
  private _message: string | undefined;

  constructor(
    private readonly _log: Logger,
    /** Which stream failed, for the log line. */
    private readonly _label: string,
    private readonly _threadId: string,
  ) {}

  /** True once a failure has been recorded, i.e. this reporter owns the run's report. */
  get pending(): boolean {
    return this._message !== undefined;
  }

  /**
   * Record `failure` as this run's forced stop, or rethrow it.
   *
   * A rethrow leaves the run to the caller's outer handler, which reports
   * `STRANDS_ERROR`. It also exits before the caller's closeout, so a message
   * left open stays open ahead of the terminal error. That is what the Python
   * adapter does with the same failures: its bare `raise` leaves the loop
   * before its own closeout block and lands on its outer handler, so the two
   * bridges put the same events on the wire.
   *
   * A classification rethrow is the ONLY throw this method may make, because
   * that is the only throw its caller knows how to read: it lets the throw skip
   * the closeout. So the order below is load-bearing. The classification check
   * runs first, the reason is latched next, and the log runs last inside its
   * own `try`. A caller-supplied `Logger` is arbitrary code and can throw,
   * `JSON.stringify` meeting a circular `cause` being enough; a throw escaping
   * it would be mistaken for a classification rethrow and would discard the
   * recorded provider failure. Latching before logging and swallowing a logger
   * failure means neither can be lost.
   *
   * No type is classified here beyond the bypass names above. A `TypeError`
   * out of the SDK call arrived from where the model, the SDK and the
   * integrator's tools all run, so it is recorded like any other failure from
   * there rather than singled out; Python classifies nothing by exception type
   * at the matching point either. The caller does test for one, but only to
   * keep it out of its frontend-halt swallow, and it reaches this method
   * either way.
   *
   * Nothing guards against a second `record` on the same run, deliberately:
   * the call site `break`s out of its consume loop the moment one returns, so
   * no later failure can reach this. Python does not guard either. It assigns
   * `force_stop_reason` unconditionally on every `force_stop` event
   * (`python/src/ag_ui_strands/agent.py`), so its last failure wins.
   */
  record(failure: unknown): void {
    // The raises Python makes after its model call returned reach its outer
    // handler instead of a ForceStopEvent, so their TS analogues reach the
    // outer handler here too and keep its STRANDS_ERROR code.
    if (STREAM_ERROR_BYPASS_NAMES.has(_errorName(failure) ?? "")) {
      throw failure;
    }
    this._message = _forceStopMessage(failure);
    try {
      // The error object, not just its text: the outer handler this diverts
      // traffic away from logs `error(prefix, e)`, which is what gives an
      // operator the stack, the name and the `cause`.
      this._log.error(
        `${LOG_PREFIX} ${this._label} force-stopped ` +
          `(threadId=${this._threadId}, reason=${this._message})`,
        failure,
      );
    } catch {
      // A logger that cannot write the line is not a reason to lose the run's
      // terminal event. Nothing is re-logged here: the sink that just threw is
      // the only one this reporter has.
    }
  }

  /**
   * The terminal events for the recorded failure.
   *
   * Emitted after the caller's own message closeout, so every message envelope
   * a client saw opened is closed before the run ends. Step envelopes are not
   * tracked here and are left exactly as the SDK's own node events paired
   * them: a `STEP_STARTED` the SDK never closed stays open, on a failed run
   * and on a healthy one alike. Harmless on a failed run, which is the one
   * this method ends, since the client verifier checks nothing on `RUN_ERROR`.
   * On a healthy run the same open step is a pre-existing protocol gap rather
   * than a decision this reporter makes; see `ARCHITECTURE.md`.
   *
   * A forced stop is a failed run, not a short success, so the caller returns
   * on these rather than falling through to STATE_SNAPSHOT and RUN_FINISHED.
   *
   * `usage` is the caller's accumulator rather than this reporter's own state:
   * a forced stop is reached from inside the stream loop, so model calls it
   * already made are real spend and travel with the failure.
   */
  *emit(usage: TokenUsage[] = []): Generator<BaseEvent, void, void> {
    if (this._message === undefined) return;
    yield _runError(this._message, FORCE_STOP_ERROR_CODE, usage);
  }
}

/**
 * Events the RAW fallback deliberately stays silent about.
 *
 * Two groups, both of which would be noise rather than new information:
 *
 * 1. Lifecycle/plumbing brackets. The TS SDK surfaces hook brackets the Python
 *    `stream_async` generator never emits, so these are the TS counterpart of
 *    Python's `init_event_loop` / `start_event_loop` / `start` skips: they carry
 *    no payload of their own and only bracket work already reported by mapped
 *    events.
 *
 * 2. Payload-carrying events whose payload is *already* on the wire under a
 *    mapped AG-UI event. Forwarding these as RAW duplicates content the client
 *    has seen — the same class of bug as Python re-emitting `ModelMessageEvent`
 *    after the text has already streamed:
 *      - `agentResultEvent`  — terminal result; already `RUN_FINISHED`.
 *      - `modelMessageEvent` — the assembled assistant message, already streamed
 *                              as `TEXT_MESSAGE_CONTENT` / `TOOL_CALL_*`.
 *      - `toolResultEvent`   — already mapped from `afterToolCallEvent` to
 *                              `TOOL_CALL_RESULT`.
 *      - `messageAddedEvent` — framework-side history bookkeeping; the client's
 *                              history comes from `MESSAGES_SNAPSHOT`.
 *
 * Deliberately NOT skipped — these carry information no mapped AG-UI event
 * conveys, which is exactly what the RAW fallback exists for (issue #2291):
 *   - `modelMetadataEvent`  — token usage and latency metrics, which the AG-UI
 *                             event set has no equivalent for.
 *   - `modelRedactionEvent` — a guardrail redaction notice. Losing it silently
 *                             would leave a client unable to tell redacted
 *                             output from an ordinary short answer.
 *
 * Everything else falls through to a RAW event.
 */
const RAW_SKIPPED_EVENT_KINDS = new Set<string>([
  // 1. Lifecycle / plumbing brackets.
  "initializedEvent",
  "beforeInvocationEvent",
  "afterInvocationEvent",
  "beforeModelCallEvent",
  "afterModelCallEvent",
  "beforeToolsEvent",
  "afterToolsEvent",
  "beforeToolCallEvent",
  "modelMessageStartEvent",
  "modelMessageStopEvent",
  // 2. Payloads already represented by a mapped AG-UI event.
  "agentResultEvent",
  "modelMessageEvent",
  "toolResultEvent",
  "messageAddedEvent",
]);

/**
 * Context keys Strands hangs off its events that are never model output.
 *
 * `agent` is a live `LocalAgent` — system prompt, full message history, model
 * configuration — and `invocationState` transitively holds the same. Hook events
 * define a `toJSON()` that drops both, but the model-layer events that reach the
 * RAW fallback after unwrapping (`modelMetadataEvent` and friends) do not, so
 * the keys are stripped by name rather than trusted to `toJSON()`.
 *
 * Mirrors `_RAW_INVOCATION_STATE_KEYS` in the Python adapter.
 */
const RAW_STRIPPED_EVENT_KEYS = new Set<string>([
  "agent",
  "invocationState",
  "requestState",
]);

/**
 * Reduce a Strands event to a JSON-safe RAW payload, or `undefined` to drop it.
 *
 * Two passes, both mandatory:
 *  1. Drop the context keys above, so no agent internals reach a client.
 *  2. Round-trip through JSON, so what we emit is plain data an in-process
 *     consumer cannot follow back to a live object.
 *
 * Anything that will not serialize is dropped rather than coerced. Coercing
 * unserializable values to strings is precisely how an agent's internals would
 * end up on the wire, so it is never an option here.
 */
function sanitizeRawEvent(event: unknown): unknown | undefined {
  if (!event || typeof event !== "object") return undefined;

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (RAW_STRIPPED_EVENT_KEYS.has(key)) continue;
    payload[key] = value;
  }
  if (Object.keys(payload).length === 0) return undefined;

  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) return undefined;
    const decoded = JSON.parse(serialized) as Record<string, unknown>;
    // A nested `toJSON()` could reintroduce a stripped key; strip once more on
    // the decoded, plain-data copy.
    for (const key of RAW_STRIPPED_EVENT_KEYS) delete decoded[key];
    return decoded;
  } catch {
    return undefined;
  }
}

/**
 * Structural interface for a Strands multi-agent orchestrator (Graph/Swarm).
 * TypeScript-only: the Python SDK currently has no orchestrator equivalent.
 */
interface StrandsOrchestrator {
  readonly id?: string;
  stream(input: string): AsyncGenerator<unknown, unknown, unknown>;
}

/**
 * How each `AgentConfig` field reaches a per-thread agent.
 *
 * - `copy`: read off the template and passed to every per-thread agent.
 * - `perThread`: the adapter supplies it per thread; a template value is
 *   deliberately ignored.
 * - `adapterOwned`: the adapter fixes the value; a template value is
 *   irrelevant rather than lost.
 * - `unsafeToShare`: readable, but owned by the template. Handing the same
 *   instance to every thread would share mutable state between conversations,
 *   so it is dropped and recorded.
 * - `notForwarded`: deliberately left behind, either because the SDK does not
 *   keep it anywhere readable or because carrying it across does more harm
 *   than losing it. Each one says which, above.
 *
 * Only `unsafeToShare` produces a per-construction record, and only at debug
 * level: Strands populates several of these on every Agent whether or not the
 * caller asked for them, so anything louder would fire for callers who set
 * nothing. `notForwarded` fields are not read at all, so there is nothing to
 * report about them beyond what this table says.
 */
type FieldDisposition =
  | "copy"
  | "perThread"
  | "adapterOwned"
  | "unsafeToShare"
  | "notForwarded";

/**
 * Fields added by Strands releases newer than the one this package was built
 * against.
 *
 * Spread into the table below so that table stays exhaustive against whichever
 * `AgentConfig` this build compiles against. Two different failures are being
 * prevented, and they need different halves of this arrangement:
 *
 * - Building against a newer SDK: the table would be missing these keys and
 *   would stop compiling. Spreading them in is what keeps the build honest
 *   without anyone having to notice the SDK moved.
 * - Shipping to a consumer on a newer SDK: the compile-time check already
 *   happened here, against the older type, and can say nothing about a field
 *   the consumer's SDK added. These keys are read at runtime regardless of
 *   whether the compiled `AgentConfig` declares them, so the setting is
 *   carried or reported rather than dropped in silence.
 *
 * Keys the running SDK does not have simply never resolve and cost nothing.
 */
const NEWER_SDK_FIELD_PLAN = {
  // Registered into an intervention registry, which keeps the caller's own
  // handler objects. This is the field that turns on native human-in-the-loop,
  // and the Python adapter already carries it, so it is carried here too.
  interventions: "copy",
  // A plain flag.
  checkpointing: "copy",
  // An execution environment rather than per-conversation state. Dropping it
  // would quietly move tool execution back onto the host, which is a worse
  // failure than sharing one environment between threads.
  sandbox: "copy",
  // A facade the SDK resolves into a conversation manager plus plugins and
  // then does not keep, so there is nothing to read back. Its effect travels
  // through those two instead.
  contextManager: "notForwarded",
  // Declared as `boolean | BackgroundTasksConfig`, but the Agent consumes it
  // into a BackgroundTasks plugin bound to that agent and registered in its
  // plugin registry, and keeps nothing under this name except that plugin.
  // Forwarding what is readable would hand a plugin to a field that expects a
  // config: every real setting (`never`, `maxConcurrency`, `timeout`) would
  // read back as undefined and fall back to its default while background
  // execution stayed switched on, so a tool the template excluded would become
  // eligible for it again. The config is plain data, so per-thread background
  // execution is set through threadAgentConfig instead.
  backgroundTasks: "notForwarded",
  // Both hold conversation-scoped data. Handing one instance to every thread
  // is the same hazard as sharing the conversation manager, so they are
  // dropped and recorded rather than cross-wired.
  memoryManager: "unsafeToShare",
  storage: "unsafeToShare",
} satisfies Record<string, FieldDisposition>;

/**
 * Every `AgentConfig` field, and what happens to it.
 *
 * The `Record<keyof Required<AgentConfig>, ...>` is the point: when Strands
 * adds a field to `AgentConfig`, this object stops type-checking until someone
 * says what should happen to it. The previous hand-written list could fall
 * behind the SDK silently, and did. Nothing here is optional, so nothing can
 * be forgotten.
 *
 * The spread above adds fields from releases newer than the one this build
 * compiles against; see its own note for why both halves are needed.
 */
const THREAD_FIELD_PLAN: Record<keyof Required<AgentConfig>, FieldDisposition> =
  {
    ...NEWER_SDK_FIELD_PLAN,
    // Forward the existing Model instance rather than a model id: Strands
    // accepts `model: string` and rebuilds a BedrockModel from it, but that
    // path discards every other field, silently breaking reasoning,
    // guardrails, and per-model tuning.
    model: "copy",
    tools: "copy",
    systemPrompt: "copy",
    name: "copy",
    description: "copy",
    id: "copy",
    appState: "copy",
    // Carries provider-side conversation state for models that keep it (a
    // response id to chain from, say). Copied because that is the shipped
    // behaviour, but a template that sets it hands the same starting point to
    // every thread; per-thread construction is tracked as follow-up work.
    modelState: "copy",
    // Turning this on makes Strands inject its structured-output tool, which
    // this adapter then streams to the client as a visible tool call, and an
    // ordinary text turn fails outright when the model does not invoke it.
    // Never actually forwarded before, because the old field list read a name
    // a built Agent does not carry. Enabling it is a protocol change, not a
    // dropped-setting fix, so it stays off until it is asked for on purpose.
    structuredOutputSchema: "notForwarded",
    toolExecutor: "copy",
    // Registered into a registry alongside Strands' own built-ins, and a
    // second Agent refuses a built-in it has already registered itself. The
    // caller's plugins reach per-thread agents through the explicit `plugins`
    // option instead.
    plugins: "notForwarded",
    // Per-thread agents start empty; AG-UI delivers history at runtime.
    messages: "perThread",
    // Supplied per thread via StrandsAgentConfig.sessionManagerProvider.
    // Forwarding the template's would make every thread share one session id.
    sessionManager: "perThread",
    // The adapter drives the stream itself and never prints.
    printer: "adapterOwned",
    // Holds the conversation window / summarisation state for one
    // conversation. Sharing one instance across threads would let one
    // conversation trim or summarise another's history.
    conversationManager: "unsafeToShare",
    // Handed to the tracer the Agent builds, which keeps it; the Agent itself
    // keeps nothing under this name or its underscore form, so there is
    // nothing here to read and nothing to carry. Digging into the tracer to
    // recover it matched on spelling rather than storage and produced wrong
    // answers, so it is declared unsupported instead of guessed at.
    traceAttributes: "notForwarded",
    // Turned into plugins and registered into the plugin registry, so what is
    // reachable is the registered strategies rather than the caller's list,
    // and re-registering those against a second agent is the same hazard as
    // plugins. A template that passes `null` to disable retries therefore gets
    // the default strategy back on each per-thread agent, which is a real
    // difference from the template and is tracked as follow-up work.
    retryStrategy: "notForwarded",
  };

/** Fields the adapter copies from the template, keyed as `AgentConfig` does. */
type TemplateAgentCloneFields = Partial<AgentConfig> & {
  model: AgentConfig["model"];
  tools: StrandsAgentCore["tools"];
};

/**
 * Read a template field, trying the conventions Strands stores it under.
 *
 * Which convention applies is not stable: `toolExecutor` is only reachable as
 * `_toolExecutor`, and reading it under its public name (as this adapter used
 * to) silently yields `undefined` for a field the caller did set.
 *
 * Only these two forms are probed. Matching a field's name against whatever
 * objects the Agent happens to hold finds coincidences as readily as storage,
 * and a wrong value forwarded confidently is worse than a field reported as
 * not carried.
 */
function _readTemplateField(agent: StrandsAgentCore, key: string): unknown {
  const record = agent as unknown as Record<string, unknown>;
  for (const attribute of [key, `_${key}`]) {
    const value = record[attribute];
    if (value !== undefined) return value;
  }
  return _readRegistryContents(agent, key);
}

/**
 * The values a registry was built from, or `undefined`.
 *
 * Some fields are consumed into a registry rather than kept under their own
 * name. The registry holds the caller's own objects, so the contents can be
 * handed to the next agent; the container around them is an implementation
 * detail and a fresh one is fine.
 */
function _readRegistryContents(
  agent: StrandsAgentCore,
  key: string,
): unknown[] | undefined {
  const singular = key.endsWith("s") ? key.slice(0, -1) : key;
  const record = agent as unknown as Record<string, unknown>;
  for (const name of [`_${singular}Registry`, `_${key}Registry`]) {
    const registry = record[name];
    if (registry === null || typeof registry !== "object") continue;
    for (const held of Object.values(registry as Record<string, unknown>)) {
      if (Array.isArray(held)) return held.length > 0 ? [...held] : undefined;
      if (held instanceof Map) {
        return held.size > 0 ? [...held.values()] : undefined;
      }
    }
  }
  return undefined;
}

/** `StateStore`-shaped values serialize to a plain object; others pass through. */
function _normalizeTemplateValue(key: string, value: unknown): unknown {
  if (key === "appState" || key === "modelState") {
    const dump = (
      value as { getAll?: () => Record<string, JSONValue> }
    )?.getAll?.();
    return dump && Object.keys(dump).length > 0 ? dump : undefined;
  }
  if (key === "tools") {
    return Array.isArray(value) ? value.slice() : undefined;
  }
  return value;
}

/**
 * Extract every forwardable field from the template Agent into per-thread
 * clones. Mirrors Python's ``_extract_agent_kwargs``.
 *
 * Returns the fields to copy plus the names of any the caller set that will
 * not reach per-thread agents, so the adapter can say so rather than dropping
 * them in silence.
 */
function _extractTemplateFields(agent: StrandsAgentCore): {
  fields: TemplateAgentCloneFields;
  ignored: string[];
  unsupported: string[];
} {
  const fields = {
    model: agent.model,
    tools: agent.tools.slice(),
  } as TemplateAgentCloneFields;
  const ignored: string[] = [];
  const unsupported: string[] = [];

  for (const [key, disposition] of Object.entries(
    THREAD_FIELD_PLAN as Record<string, FieldDisposition>,
  )) {
    if (disposition === "perThread" || disposition === "adapterOwned") continue;

    const raw = _readTemplateField(agent, key);
    if (raw === undefined) continue;

    if (disposition === "notForwarded") {
      // Read first, then report. Skipping the read made an explicitly set
      // value that this adapter will not carry look identical to one the
      // caller never set, which is the silent change of behaviour this whole
      // change exists to remove. Where the SDK keeps nothing readable there is
      // still nothing to report, and the plan says so per field.
      unsupported.push(key);
      continue;
    }

    if (disposition === "unsafeToShare") {
      ignored.push(key);
      continue;
    }

    const value = _normalizeTemplateValue(key, raw);
    if (value === undefined) continue;
    (fields as Record<string, unknown>)[key] = value;
  }

  return { fields, ignored, unsupported };
}

/**
 * Read an AG-UI tool message as the pair every consumer needs: the result body
 * as text, and the client-reported failure when there is one.
 *
 * The native `toolResult` blocks and the synthetic continuation prompt both
 * announce the same tool message to the model, so both read it through here:
 * reading `content` without `error` announces a failed frontend tool as a
 * success, and deriving the pair per path lets the paths disagree.
 */
function _readToolResult(msg: unknown): {
  text: string;
  error?: string;
  status: "success" | "error";
} {
  const raw = (msg ?? {}) as { content?: unknown; error?: unknown };
  // Presence is the signal, not truth: `error: ""` is a client saying its tool
  // failed with nothing to add, and read for truth it would answer as a
  // success. An absent `error` is the only success, `null` included, since that
  // is how a serializer writes "no error" for an optional string.
  const failed = raw.error != null;
  return {
    text: _coerceText(raw.content),
    ...(failed ? { error: String(raw.error) } : {}),
    status: failed ? "error" : "success",
  };
}

/**
 * Read an AG-UI tool message as one client answer.
 *
 * The reason travels with the failure flag so a persisted result can say why a
 * frontend tool failed rather than only that it did, and so the reconciler and
 * the replayed history describe the same answer to `clientResultFields`.
 */
function _clientResult(msg: unknown): PendingFrontendResult {
  const { text, error, status } = _readToolResult(msg);
  return {
    text,
    // The status, not the reason: a failure with an empty reason is still a
    // failure.
    isError: status === "error",
    ...(error ? { errorReason: error } : {}),
  };
}

/**
 * One line of the continuation prompt: what the tool was, and what came back.
 *
 * Forwards the ACTUAL result so the model can act on the human's decision (e.g.
 * an approval resolving to `{"approved": false}`); announcing a bare success
 * silently breaks HITL, telling the model the tool returned nothing. The
 * synthetic acknowledgement is only for a genuinely empty result, and a
 * client-reported failure carries its reason with an empty body, so reading the
 * body alone would report that failure as a success.
 *
 * Shared by every place a client answer has to be SAID rather than persisted.
 * `resultText` is the same answer's persisted wording, which omits the name
 * because a `toolResult` block is already attached to the call it answers.
 */
function _continuationResultLine(
  name: string,
  result: PendingFrontendResult,
): string {
  // Trimmed, and a failure with nothing usable left still reads as a failure.
  // `resultText` renders the persisted half of the same answer and must branch
  // identically, or a reason of blank space takes the has-a-reason branch on one
  // side and the no-reason branch on the other. Only the wording differs,
  // because only this line names the tool.
  const reason = result.errorReason?.trim();
  if (reason) {
    return result.text.trim()
      ? `${name} failed: ${reason} (returned: ${result.text})`
      : `${name} failed: ${reason}`;
  }
  if (result.isError) {
    return result.text.trim()
      ? `${name} failed: ${result.text}`
      : `${name} failed: no reason given.`;
  }
  if (result.text.trim()) return `${name} returned: ${result.text}`;
  return `${name} executed successfully with no return value.`;
}

/** Return ``value`` if it is a non-empty string, else a fresh UUID. */
function _coerceId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : uuid();
}

/**
 * Human-readable description of what the busy guard is protecting.
 *
 * A thread is the only scope this side guards, so a thread is the only scope
 * this renders. Python's `_busy_scope` takes the guard key rather than a
 * thread id and also renders a whole shared orchestrator, which it needs
 * because a single orchestrator instance there refuses every overlapping run
 * whatever its thread. Both sides emit the same `THREAD_BUSY` template; only
 * the set of scopes that can fill it differs.
 */
function _busyScope(threadId: string): string {
  return `thread "${threadId}"`;
}

/** Extract a human-readable message from an unknown error. */
function _errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A failure this adapter reports but did not cause.
 *
 * `TypeError` and `ReferenceError` are what a defect in this adapter's own
 * code throws, which is why the terminal-error classifier reads them as
 * `ADAPTER_BUG`. They are also what an integrator's tool throws, and what
 * `JSON.stringify` throws over a value from outside this adapter. Throwing
 * this instead at the places that know the fault came from outside keeps
 * `ADAPTER_BUG` pointing at code the maintainer of this adapter can fix.
 *
 * It carries the original failure's message so the wire text is unchanged, and
 * the original value as `cause` so the stack still names the real origin. A
 * `prefix` is how a caller adds its own framing without replacing either.
 * Python's `_ForeignFault` is the same arm.
 *
 * Constructing one is total. Deriving the message is a call into arbitrary
 * code (`_errorMessage` reads `message` off the thrown value, which a getter
 * or a `Proxy` trap can define), and a wrapper that throws while wrapping
 * hands the classifier the very `TypeError` it was built to suppress.
 */
class _ForeignFault extends Error {
  constructor(cause: unknown, prefix?: string) {
    const text = _safeErrorMessage(cause);
    super(prefix ? `${prefix}: ${text}` : text);
    this.name = "ForeignFault";
    this.cause = cause;
  }
}

/**
 * `_errorMessage` that cannot itself throw.
 *
 * A value whose text cannot be read falls back to its name, which is what
 * Python's `_exception_text` falls back to, and to a constant when there is no
 * readable name either.
 */
function _safeErrorMessage(e: unknown): string {
  try {
    return _errorMessage(e);
  } catch {
    return _errorName(e) ?? "Unknown error";
  }
}

/**
 * The RUN_ERROR code for a failure that escaped a run loop.
 *
 * `FRONTEND_TOOL_IDENTITY_ERROR` is claimed first and on identity alone: a
 * frontend call this bridge cannot correlate through Strands' native tool-use
 * id is neither a fault from outside nor a defect here, and the exception
 * carries the sentence the client reads. Only what gets past it is classified
 * by type below.
 *
 * `ADAPTER_BUG` says the fault is in this adapter and sends the developer
 * reading it here rather than to the provider or the SDK, so it is claimed
 * only for the types a code defect throws AND only when nothing upstream has
 * established that the fault came from elsewhere. A `_ForeignFault` is that
 * establishment: the orchestrator's stream boundary and the tool-result
 * serializer throw it for failures this adapter merely reported.
 *
 * The claim is still made on type alone, so it is a claim and not a proof.
 * Adapter code that runs inside the Strands call (a registered hook, a proxy
 * tool) throws from where the SDK does and so is never reported as this
 * adapter's defect either, which is the direction that costs a developer a
 * wrong-looking code rather than a wrong place to look.
 */
function _terminalErrorCode(e: unknown): string {
  if (e instanceof FrontendToolIdentityError) {
    return "FRONTEND_TOOL_IDENTITY_ERROR";
  }
  return e instanceof TypeError || e instanceof ReferenceError
    ? "ADAPTER_BUG"
    : "STRANDS_ERROR";
}

/**
 * Re-yield `source`, reporting anything it throws as a `_ForeignFault`, with
 * `contextBlock` in scope for each pull.
 *
 * The orchestrator pulls its stream through a `for await`, which leaves no
 * boundary between what the SDK raised and what this adapter's translation of
 * an event raised. This restores one, as Python's
 * `_stream_with_model_context` does for both of its loops. The single-agent
 * loop needs no equivalent for faults: it reports every failure out of its own
 * `next()` as the forced stop, which never reaches the classifier at all. The
 * other half of Python's wrapper, scoping the request's model context to one
 * pull at a time, is shared with that loop through `pullWithModelContext`, so
 * an orchestrator's leaf agents see the block on the same terms a single
 * agent does. Teardown stays with the caller, which already returns the
 * underlying stream in its own `finally`.
 */
async function* _foreignStreamFaults<T>(
  source: AsyncIterable<T>,
  contextBlock = "",
): AsyncGenerator<T, void, void> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    let next: IteratorResult<T, unknown>;
    try {
      next = await pullWithModelContext(iterator, contextBlock);
    } catch (e) {
      throw new _ForeignFault(e);
    }
    if (next.done) return;
    yield next.value;
  }
}

/**
 * Serialize a tool result for the AG-UI string field.
 *
 * The value comes from an integrator's tool, and `JSON.stringify` throws a
 * `TypeError` over two shapes a tool can hold without noticing: a `BigInt`,
 * and a structure that refers back to itself. Both are that tool's contract to
 * fix rather than a defect here, which is what the terminal-error classifier
 * would otherwise read them as. Python's `_serialize_tool_result_data` is the
 * same arm over `json.dumps`.
 */
function _serializeToolResultData(resultData: unknown): string {
  if (resultData == null) return "";
  try {
    return JSON.stringify(resultData);
  } catch (e) {
    throw new _ForeignFault(e, "Tool result is not JSON serializable");
  }
}

/**
 * The initial STATE_SNAPSHOT payload, or `undefined` for no snapshot.
 *
 * AG-UI types `state` as any value, so a client is free to send something that
 * is not a keyed object. Only a keyed object can carry the `messages` key the
 * frontend manages separately and does not want echoed back, which is what the
 * filter is for; an array taken through the same filter reaches the wire as an
 * index-keyed object nobody asked for, and a scalar reaches it as a snapshot
 * that is not an object at all. Neither is a payload this event has carried
 * before, so a non-object gets no snapshot. Python's
 * `_state_snapshot_payload` is the same arm.
 */
function _stateSnapshotPayload(
  state: unknown,
): Record<string, unknown> | undefined {
  if (!_isPlainStateObject(state)) return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
    if (k !== "messages") snapshot[k] = v;
  }
  return snapshot;
}

/** Whether a client-supplied `state` is a keyed object rather than a value. */
function _isPlainStateObject(state: unknown): boolean {
  return state !== null && typeof state === "object" && !Array.isArray(state);
}

/**
 * Return every native Strands interrupt on the checkpoint, keyed by ID.
 *
 * Strands' current InterruptState serializes `interrupts` as a Record, while
 * older mocks used a Map. Supporting both keeps cold-start validation aligned
 * with the state that SessionManager actually restores, and every reader of the
 * restored interrupts goes through here so only one place knows both shapes.
 */
function _nativeInterruptsById(interrupts: unknown): Map<string, unknown> {
  const entries: Iterable<[string, unknown]> =
    interrupts instanceof Map
      ? interrupts.entries()
      : interrupts && typeof interrupts === "object"
        ? Object.entries(interrupts)
        : [];
  return new Map(entries);
}

/**
 * Return the native Strands interrupts still awaiting a human, keyed by ID.
 *
 * An interrupt carrying a recorded response was already answered, so it must
 * not be demanded again on the next resume. This mirrors the SDK's own
 * `response === undefined` predicate: presence decides, not truthiness, so an
 * answer of `false`, `0` or `""` counts as answered.
 *
 * The native interrupt state is the only record of what is still in flight, so
 * every "is anything still open?" decision reads it through here.
 */
function _openNativeInterrupts(interrupts: unknown): Map<string, unknown> {
  const open = new Map<string, unknown>();
  for (const [id, interrupt] of _nativeInterruptsById(interrupts)) {
    const response = (interrupt as { response?: unknown } | null)?.response;
    if (response === undefined) open.set(id, interrupt);
  }
  return open;
}

/** Structural equality over the JSON-shaped answers Strands records. */
function _sameRecordedAnswer(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return (
      a.length === b.length &&
      a.every((item, index) => _sameRecordedAnswer(item, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => key in right && _sameRecordedAnswer(left[key], right[key]),
    )
  );
}

/**
 * True when `entries` re-submits exactly the answers the checkpoint already holds.
 *
 * Strands records the submitted answers before it reruns hooks and the parked
 * tool execution, and clears the checkpoint only once that work succeeds. So a
 * hook failure, or a crash after session persistence, can restore a checkpoint
 * that is activated with every interrupt already answered. That thread has no
 * way forward: fresh input is refused because the checkpoint is active, and a
 * resume finds nothing open to address. Handing Strands the identical batch is
 * the way out, because it lets the SDK finish the parked execution. The
 * checkpoint itself must be left alone: clearing it would discard exactly that
 * parked execution. Anything short of an exact replay stays refused.
 */
function _replaysRecordedAnswers(
  interrupts: unknown,
  entries: ResumeEntry[],
): boolean {
  const recorded = _nativeInterruptsById(interrupts);
  if (recorded.size === 0 || entries.length !== recorded.size) return false;
  const addressed = new Set<string>();
  for (const entry of entries) {
    const interrupt = recorded.get(entry.interruptId);
    if (!interrupt || addressed.has(entry.interruptId)) return false;
    addressed.add(entry.interruptId);
    const answer = (interrupt as { response?: unknown }).response;
    if (answer === undefined) return false;
    if (_sameRecordedAnswer(answer, toResumeResponse(entry, interrupt)))
      continue;
    // The legacy fallback exists only for a checkpoint written before the
    // envelope, so it must not fire for an answer this release could have
    // written itself. Without that guard a client that pre-wrapped its payload
    // matches on the legacy shape and is then resumed with a second envelope
    // around the first, silently. A pre-envelope payload that happened to look
    // like an envelope is refused instead of accepted, which is the safe way to
    // be wrong here.
    if (_isCurrentGenericAnswer(answer)) return false;
    if (!_sameRecordedAnswer(answer, _legacyResumeResponse(entry)))
      return false;
  }
  return true;
}

/**
 * True when `answer` is an envelope this release wraps a resolved answer in.
 *
 * Only the wrapped-answer key belongs here. The cancellation shape looks the
 * same as a pre-envelope cancel PAYLOAD, which the shipped example's Cancel
 * button submitted, so treating it as one of ours would refuse exactly the
 * migration the legacy fallback exists for.
 *
 * That leaves one genuinely undecidable case, accepted knowingly: a resolved
 * entry whose payload is `{cancelled:true}` matches both a pre-envelope raw
 * payload and a cancellation this release recorded, and nothing in the entry or
 * the checkpoint tells the two apart. It is treated as the migration, because
 * that case is real and the other needs a client to resolve an interrupt with a
 * payload that is exactly a cancellation.
 */
function _isCurrentGenericAnswer(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return false;
  }
  const keys = Object.keys(answer);
  return keys.length === 1 && keys[0] === "response";
}

/**
 * The answer the release before the resume envelope would have submitted.
 *
 * Read ONLY by the replay comparison. A checkpoint the SDK parked mid-resume
 * before that release carries answers in this older shape, and an exact replay
 * is the only way to finish the execution it holds, so a batch matching what the
 * old code submitted still has to be recognised. Nothing else may use it: what
 * this release submits is always the current shape.
 *
 * Python needs no counterpart for the envelope itself, which predates this
 * change, so a checkpoint parked there already holds the shape it still
 * computes. The one Python answer this change does move is the degenerate
 * approval whose reason did not survive: the relaxed classifier now answers it
 * raw when resolved and `{approved:false}` when cancelled, where both were
 * previously enveloped. That side has its own narrow equivalent of this
 * function for exactly that interrupt, and nothing wider.
 */
function _legacyResumeResponse(entry: ResumeEntry): unknown {
  if (entry.status === "cancelled") return { status: "cancelled" };
  return entry.payload === undefined ? {} : (entry.payload as unknown);
}

/**
 * Reserved native-interrupt name prefix for interrupts this adapter's
 * `interruptOnCall` hook raises. Anything else is a generic native interrupt.
 *
 * Reserved means reserved: an interrupt raised anywhere else under this prefix
 * is classified, schema-checked and answered as an approval.
 */
const TOOL_APPROVAL_NAME_PREFIX = "ag_ui:tool_call:";

/**
 * The shape a paused `context.interrupt()` is answered with when the client
 * cancels (`ResumeEntry.status === "cancelled"`) rather than resolving, so a
 * generic tool can treat the pause as a denial.
 *
 * Compare by value, not by identity: every answer is a fresh copy, so that a
 * tool mutating what it received cannot poison later cancellations. Frozen for
 * the same reason. A cancelled tool approval is answered `{ approved: false }`
 * instead, which is the denial its own hook reads.
 */
export const INTERRUPT_CANCELLED = Object.freeze({ cancelled: true } as const);

/**
 * The response contract advertised for a tool-approval interrupt.
 *
 * Single source for both the schema published on the AG-UI `Interrupt` and the
 * resume-payload validation, so a resume can still be checked when the AG-UI
 * bookkeeping did not survive a process restart.
 */
function toolApprovalResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
  };
}

/**
 * True when a native Strands interrupt came from the approval hook.
 *
 * The reserved name prefix is the whole test. It also decides whether a resume
 * is answered raw or wrapped, so it deliberately does not additionally require
 * the reason: an approval whose reason did not survive a restart still has to
 * be answered in the shape its own hook reads.
 */
function isToolApprovalInterrupt(interrupt: unknown): boolean {
  const name = (interrupt as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.startsWith(TOOL_APPROVAL_NAME_PREFIX);
}

/** A frontend call cannot be correlated through Strands' native ID. */
export class FrontendToolIdentityError extends Error {
  constructor(message: string) {
    super(message);
    // Without this, name-based inspection reports the base "Error".
    this.name = "FrontendToolIdentityError";
  }
}

function _missingFrontendToolIdentityError(
  toolName: string,
): FrontendToolIdentityError {
  return new FrontendToolIdentityError(
    `Frontend tool '${toolName}' requires a non-empty, unique native ` +
      "toolUseId from Strands. Upgrade the Strands model provider or use " +
      "one that supplies stable tool-use IDs.",
  );
}

function _duplicateFrontendToolIdentityError(
  nativeToolUseId: string,
): FrontendToolIdentityError {
  return new FrontendToolIdentityError(
    "Frontend tools require a non-empty, unique native toolUseId for each " +
      `call, but Strands reused '${nativeToolUseId}'. Upgrade the Strands ` +
      "model provider or avoid parallel frontend calls with that provider.",
  );
}

function _reusedFrontendToolIdentityError(
  nativeToolUseId: string,
): FrontendToolIdentityError {
  return new FrontendToolIdentityError(
    "Frontend tools require a transcript-unique native toolUseId, but " +
      `Strands reused '${nativeToolUseId}' from prior thread history. ` +
      "Upgrade the Strands model provider or use one that supplies stable " +
      "tool-use IDs.",
  );
}

/**
 * Every `toolUse` an assistant message carries, as `(id, name)` pairs.
 *
 * Accepts both shapes the SDK uses for the same block: the live `ToolUseBlock`
 * instance held in `agent.messages`, and the serialized `{ toolUse: {...} }`
 * form used by `MessageData` (which is how a checkpoint parks the assistant
 * message that raised it). `name` is an empty string when the block does not
 * carry one, so an id is still reported for the identity guards.
 */
function _assistantToolUses(
  messages: readonly unknown[] | undefined,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const message of messages ?? []) {
    const record = message as { role?: unknown; content?: unknown };
    if (record?.role !== "assistant" || !Array.isArray(record.content))
      continue;
    for (const block of record.content) {
      const live = block as {
        type?: unknown;
        toolUseId?: unknown;
        name?: unknown;
      };
      const data = (block as { toolUse?: unknown }).toolUse as
        | { toolUseId?: unknown; name?: unknown }
        | undefined;
      const use = live?.type === "toolUseBlock" ? live : data;
      if (!use) continue;
      const id = use.toolUseId;
      if (typeof id !== "string" || !id) continue;
      pairs.push([id, typeof use.name === "string" ? use.name : ""]);
    }
  }
  return pairs;
}

/**
 * Every text a user message of the native history carries.
 *
 * Reads both shapes the SDK uses, as `_assistantToolUses` does: the live
 * `TextBlock` instance and the serialized `{ text }` form both expose the text
 * under the same key, and no other block kind of a user message carries one at
 * the top level (a `toolResult` nests its own one level deeper, which is the
 * PERSISTED wording of an answer rather than a prompt's).
 *
 * User messages only: what a continuation prompt said is what the run itself
 * put there, and an assistant message repeating a phrase said nothing to the
 * model.
 */
function _nativeUserTexts(messages: readonly unknown[] | undefined): string[] {
  const texts: string[] = [];
  for (const message of messages ?? []) {
    const record = message as { role?: unknown; content?: unknown };
    if (record?.role !== "user" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      const text = (block as { text?: unknown })?.text;
      if (typeof text === "string" && text) texts.push(text);
    }
  }
  return texts;
}

/**
 * The assistant message a checkpoint parked, if any.
 *
 * Strands defers appending the assistant `toolUse` message until the whole tool
 * batch completes, so an interrupt mid-batch leaves it OUT of `agent.messages`
 * and inside the checkpoint. On a resume run it is therefore the only place
 * naming the tools of that batch.
 */
function _parkedAssistantMessages(agent: unknown): unknown[] {
  const parked = (agent as { _interruptState?: unknown })?._interruptState as
    | { pendingToolExecution?: { assistantMessageData?: unknown } }
    | undefined;
  const message = parked?.pendingToolExecution?.assistantMessageData;
  return message ? [message] : [];
}

/** Native tool-use IDs already present in Strands history or a checkpoint. */
function _nativeAssistantToolCallIds(agent: unknown): Set<string> {
  const messages = [
    ...((agent as { messages?: unknown[] }).messages ?? []),
    ..._parkedAssistantMessages(agent),
  ];
  return new Set(_assistantToolUses(messages).map(([id]) => id));
}

/**
 * The tracked call currently holding `strandsToolId`, if any.
 *
 * The map is keyed by the AG-UI id, which for a backend call can differ from
 * Strands' own, so the native id has to be searched for rather than looked up.
 */
function _trackedByNativeId(
  seen: Map<string, SeenToolCall>,
  strandsToolId: string,
): SeenToolCall | undefined {
  for (const data of seen.values()) {
    if (data.strandsToolId === strandsToolId) return data;
  }
  return undefined;
}

interface ResolveToolUseIdArgs {
  seen: Map<string, SeenToolCall>;
  /** Tool name, reported when Strands supplies no usable native id. */
  toolName: string;
  /** Exactly what Strands supplied; frontend identity is asserted on this. */
  nativeToolUseId: string | undefined;
  /** Id a BACKEND tool falls back to when Strands supplied none. */
  fallbackToolUseId: string;
  isFrontendTool: boolean;
  /** Native ids already in this thread's history, before this run streamed. */
  priorToolCallIds: ReadonlySet<string>;
  /** Called once, when a new frontend call is admitted under its native id. */
  onNewFrontendCall: (toolUseId: string) => void;
  /**
   * True for the assembled `ToolUseBlock` re-delivering a call already tracked
   * under this native id, so a closed envelope on that id is the same call
   * rather than a reused one. Must be false for every other assembled sighting:
   * a provider emitting no deltas at all reaches this branch with genuinely new
   * calls, and a second sighting under an id already spent is a real reuse.
   */
  isAssembledRedelivery?: boolean;
}

/**
 * Resolve the AG-UI-side tool call id from an incoming Strands tool use.
 *
 * - If we've already seen this Strands tool (by internal id), reuse the
 *   existing AG-UI id so every envelope event carries the same id.
 * - Frontend tools carry Strands' native identity onto the wire, so the id the
 *   client answers under is the id Strands persisted the placeholder
 *   `toolResult` against. A separate id here leaves that placeholder unfindable
 *   on a later run, and so uncorrectable.
 * - Backend tools reuse Strands' own id so result lookup works.
 *
 * @throws FrontendToolIdentityError when a frontend call has no usable native
 * id, because a wire id that names nothing in the persisted history is worse
 * than refusing the call.
 */
function _resolveToolUseId(args: ResolveToolUseIdArgs): string {
  const {
    seen,
    toolName,
    nativeToolUseId,
    fallbackToolUseId,
    isFrontendTool,
    priorToolCallIds,
    onNewFrontendCall,
    isAssembledRedelivery = false,
  } = args;
  const strandsToolId = nativeToolUseId ?? fallbackToolUseId;

  // A cumulative update for a call already in flight, before cross-call
  // uniqueness applies. A frontend entry whose envelope already closed is not
  // one of those: it is a second call landing on a reused id.
  let existingEntry: string | undefined;
  let endedFrontendEntry = false;
  for (const [tid, data] of seen) {
    if (data.strandsToolId !== strandsToolId) continue;
    if (isFrontendTool && data.endEmitted && !isAssembledRedelivery) {
      endedFrontendEntry = true;
      break;
    }
    existingEntry = tid;
    break;
  }

  if (isFrontendTool) {
    if (typeof nativeToolUseId !== "string" || !nativeToolUseId.trim()) {
      throw _missingFrontendToolIdentityError(toolName);
    }
    if (endedFrontendEntry) {
      throw _duplicateFrontendToolIdentityError(nativeToolUseId);
    }
    if (existingEntry === undefined && priorToolCallIds.has(nativeToolUseId)) {
      throw _reusedFrontendToolIdentityError(nativeToolUseId);
    }
  }

  if (existingEntry !== undefined) return existingEntry;
  if (isFrontendTool) {
    onNewFrontendCall(nativeToolUseId!);
    return nativeToolUseId!;
  }
  return strandsToolId || uuid();
}

/**
 * Emit a TOOL_CALL_END for every tracked tool call that started but never
 * ended, so the stream is left with no active tool calls.
 *
 * Parallel tool fan-out (e.g. gpt-4o chaining weather + flights + dice in one
 * turn) can leave sibling calls mid-flight: when a `stopStreamingAfterResult`
 * tool returns first it halts the stream before the other calls reach their
 * `contentBlockStop`/TOOL_CALL_END. Without draining them, the terminal
 * RUN_FINISHED trips the AG-UI client verifier's "tool calls still active"
 * guard (runtimeErrorCode INCOMPLETE_STREAM). Idempotent: flips `endEmitted`
 * so a second drain (or a normal-path call after the events already went out)
 * is a no-op.
 */
function* _drainPendingToolCalls(
  seen: Map<string, SeenToolCall>,
): Generator<BaseEvent> {
  for (const [toolCallId, entry] of seen) {
    if (entry.startEmitted && !entry.endEmitted) {
      entry.endEmitted = true;
      yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
    }
  }
}

/**
 * Convert ``RunAgentInput.messages`` to AG-UI message objects.
 *
 * Used to seed the running ``MessagesSnapshotEvent`` payload so each snapshot
 * carries the full thread history.
 */
/**
 * The message's own metadata, when it is something the wire can carry.
 *
 * `buildSnapshotMessages` is handed unvalidated objects and coerces every other
 * field it reads, so metadata gets the same treatment: anything that is not a
 * plain object is dropped rather than forwarded.
 */
function _carriedMetadata(msg: unknown): Record<string, unknown> | undefined {
  const metadata = (msg as { metadata?: unknown } | null)?.metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  if (Array.isArray(metadata)) return undefined;
  // Copied, not referenced: the rebuilt message is retained and re-emitted in
  // every later snapshot, so handing back the caller's object would alias the
  // client's own input into all of them. A value that will not encode is
  // dropped rather than carried, matching the citation path.
  return jsonRoundTrip(metadata as Record<string, unknown>);
}

export function buildSnapshotMessages(
  input_messages: AguiMessage[],
): AguiMessage[] {
  const out: AguiMessage[] = [];
  for (const msg of input_messages ?? []) {
    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    const msgId = _coerceId((msg as { id?: string }).id);
    if (role === "user") {
      const user: AguiUserMessage = {
        id: msgId,
        role: "user",
        content: _coerceText(msg.content),
      };
      const userMetadata = _carriedMetadata(msg);
      if (userMetadata) user.metadata = userMetadata;
      out.push(user);
    } else if (role === "assistant") {
      const rawToolCalls = (msg as { toolCalls?: AguiToolCall[] }).toolCalls;
      let toolCalls: AguiToolCall[] | undefined;
      if (rawToolCalls && rawToolCalls.length > 0) {
        toolCalls = rawToolCalls.map((tc) => {
          const fn = tc.function as
            | { name?: string; arguments?: string }
            | undefined;
          return {
            id: _coerceId(tc.id),
            type: "function" as const,
            function: {
              name: fn?.name ?? "unknown",
              arguments: fn?.arguments ?? "{}",
            },
          };
        });
      }
      const assistant: AguiAssistantMessage = {
        id: msgId,
        role: "assistant",
        content: _coerceText(msg.content),
      };
      if (toolCalls) assistant.toolCalls = toolCalls;
      // Same reason the tool branch below preserves error/encryptedValue: this
      // is an AG-UI -> AG-UI rebuild of the client's own message, and a
      // snapshot REPLACES what the client assembled. Dropping metadata here
      // erases the previous turn's citations the moment turn two starts.
      const assistantMetadata = _carriedMetadata(msg);
      if (assistantMetadata) assistant.metadata = assistantMetadata;
      out.push(assistant);
    } else {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId ?? "";
      const { error, encryptedValue } = msg as {
        error?: string;
        encryptedValue?: string;
      };
      const tool = {
        id: msgId,
        role: "tool",
        content: _coerceText(msg.content),
        toolCallId,
      } as AguiToolMessage;
      // This is an AG-UI -> AG-UI rebuild of the client's own message, so
      // preserve its error/encryptedValue on the snapshot echo instead of
      // silently dropping the client's own fields.
      if (error !== undefined) tool.error = error;
      if (encryptedValue !== undefined) tool.encryptedValue = encryptedValue;
      const toolMetadata = _carriedMetadata(msg);
      if (toolMetadata) tool.metadata = toolMetadata;
      out.push(tool);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The turn's tool calls, resolved once
// ---------------------------------------------------------------------------
//
// A continuation turn answers the same handful of questions about a tool call in
// several places: what the tool was, whether the client executed it, whether
// this adapter may rewrite its persisted placeholder, and whether a history
// built from the request can carry its answer at all. Deriving each where it is
// needed, from whichever source is nearest (the incoming request messages, the
// stored native history, the recorded call ids), lets the derivations disagree:
// a name resolved off the STORE while the history built from the REQUEST drops
// the very result it names is a re-fire loop. So the sources are read once,
// here, and every consumer reads this.

/** One `toolUse` of this turn, resolved against every source at once. */
interface ResolvedToolCall {
  /** The AG-UI id, which for a frontend call is Strands' own `toolUseId`. */
  id: string;
  /** The tool's name, or undefined when no source names it. */
  name?: string;
  /** Index of the request message that opens the call, if the request has one. */
  requestCallIndex?: number;
}

/** One `tool` message of the request, resolved the same way. */
interface ResolvedToolResult {
  /** Exactly what the message carried, so a missing id reads as missing. */
  toolCallId: string | undefined;
  /** The name of the call it answers. */
  name?: string;
  /** The client's answer, read once through the shared reader. */
  result: PendingFrontendResult;
  /** Index of this message in the request. */
  index: number;
  /** True when the message sits in the request's TRAILING run of results. */
  trailing: boolean;
  /** True when either provenance signal says the client executed the call. */
  clientExecuted: boolean;
  /** True when a recorded call id admits the answer for reconciliation. */
  admitted: boolean;
  /**
   * True when the request opens the call BEFORE this message, so a history
   * built from the request offers the result a `toolUse` to answer.
   */
  offeredHome: boolean;
  /** True when this turn reads the message as a client answer. */
  isClientAnswer: boolean;
  /**
   * True when the model's own history ALREADY says this answer in words: an
   * earlier turn carried it in a continuation prompt, and that prompt is a
   * persisted user message.
   *
   * The line compared is the one the shared helper builds, so this asks what
   * would be said against what was said. Without it, a placeholder no
   * correction can ever repair keeps both provenance signals alive and its
   * answer is prepended to every later prompt of the thread, without bound.
   */
  alreadyPrompted: boolean;
}

/** Everything a continuation turn knows about its own tool calls. */
interface ResolvedTurn {
  /** Every call this turn knows of, keyed by id. */
  calls: ReadonlyMap<string, ResolvedToolCall>;
  /** Every `tool` message of the request, in request order. */
  results: readonly ResolvedToolResult[];
  /** Ids of the trailing results, which duplicate suppression reads. */
  trailingResultIds: readonly string[];
  /** The client answers this turn carries, in request order. */
  clientAnswers: readonly ResolvedToolResult[];
  /** True when a user message follows the LAST client answer. */
  hasNewerUserMessage: boolean;
  /** Client answers a history built from the request would have to drop. */
  unreplayableAnswerIds: readonly string[];
  /** Call ids the request opens and never answers. */
  unansweredRequestCallIds: ReadonlySet<string>;
}

/**
 * Resolve this turn's tool calls from every source at once.
 *
 * Pure: it reads, and nothing it is handed is mutated. The request is walked
 * once for the calls it declares and the results it carries, the native history
 * fills in names the request never had (which is all a delta-only continuation
 * has), and the two provenance sets say who executed what.
 */
function _resolveTurnToolCalls(args: {
  messages: readonly AguiMessage[];
  /** Stored native history plus whatever a checkpoint parked. */
  nativeMessages: readonly unknown[];
  frontendToolNames: ReadonlySet<string>;
  /** Call ids this adapter recorded when it handed them to the client. */
  recordedCallIds: ReadonlySet<string>;
  /** Call ids whose proxy placeholder this adapter still holds. */
  stubbedCallIds: ReadonlySet<string>;
  /** Results this run's `resume[]` addresses through their interrupt. */
  resumeBoundResultIds: ReadonlySet<string>;
}): ResolvedTurn {
  const messages = args.messages;
  const calls = new Map<string, ResolvedToolCall>();
  const entryFor = (id: string): ResolvedToolCall => {
    const existing = calls.get(id);
    if (existing) return existing;
    const created: ResolvedToolCall = { id };
    calls.set(id, created);
    return created;
  };

  // First mention wins for both the name and the index: a request repeating a
  // call describes one call, and a history built from it opens that call once.
  const resultIndicesById = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "assistant") {
      for (const tc of (msg as { toolCalls?: AguiToolCall[] }).toolCalls ??
        []) {
        if (!tc.id) continue;
        const entry = entryFor(tc.id);
        if (entry.requestCallIndex === undefined) entry.requestCallIndex = i;
        const name = (tc.function as { name?: string } | undefined)?.name;
        if (name && !entry.name) entry.name = name;
      }
    } else if (msg.role === "tool") {
      const id = (msg as { toolCallId?: string }).toolCallId;
      if (!id) continue;
      const indices = resultIndicesById.get(id) ?? [];
      indices.push(i);
      resultIndicesById.set(id, indices);
    }
  }

  // On a delta-only continuation the assistant message carrying the call is
  // absent from the request, so the stored native history (and the batch a
  // checkpoint parked) is the only thing naming the tool that actually ran.
  for (const [id, name] of _assistantToolUses(args.nativeMessages)) {
    if (!name) continue;
    const entry = entryFor(id);
    if (!entry.name) entry.name = name;
  }

  // The trailing run: the results at the very END of the request. That is what
  // the continuation prompt phrases, and it is where a user message after a
  // result puts that result out of reach.
  let trailingFrom = messages.length;
  while (trailingFrom > 0 && messages[trailingFrom - 1]?.role === "tool") {
    trailingFrom--;
  }

  // Every continuation prompt this thread has already sent, as the model holds
  // them: a prompt goes out as the run's user message and is persisted with the
  // rest of the history. Read once, so the "was this answer already said?" test
  // below is a search of what the model can actually see.
  const promptedTexts = _nativeUserTexts(args.nativeMessages);

  const results: ResolvedToolResult[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "tool") continue;
    const toolCallId = (msg as { toolCallId?: string }).toolCallId;
    const entry = toolCallId ? calls.get(toolCallId) : undefined;
    const name = entry?.name;
    const result = _clientResult(msg);
    // Unnameable answers are never said at all: the run fails closed on them.
    const promptLine = name ? _continuationResultLine(name, result) : undefined;
    const clientExecuted =
      !!toolCallId &&
      (args.recordedCallIds.has(toolCallId) ||
        args.stubbedCallIds.has(toolCallId));
    // Provenance is either signal, not declaration alone: a continuation that
    // declares no tools (`tools: []`) still carries a real frontend result, and
    // reading the declarations alone files it as a backend result and hands the
    // model a greeting instead of the answer.
    const isClientAnswer =
      !!toolCallId &&
      (i >= trailingFrom ||
        args.resumeBoundResultIds.has(toolCallId) ||
        clientExecuted) &&
      ((!!name && args.frontendToolNames.has(name)) || clientExecuted);
    const callIndex = entry?.requestCallIndex;
    results.push({
      toolCallId,
      ...(name ? { name } : {}),
      result,
      index: i,
      trailing: i >= trailingFrom,
      clientExecuted,
      admitted: !!toolCallId && args.recordedCallIds.has(toolCallId),
      offeredHome: callIndex !== undefined && callIndex < i,
      isClientAnswer,
      alreadyPrompted:
        !!promptLine && promptedTexts.some((text) => text.includes(promptLine)),
    });
  }

  const clientAnswers = results.filter((result) => result.isClientAnswer);
  const lastAnswerIndex =
    clientAnswers.length > 0
      ? clientAnswers[clientAnswers.length - 1]!.index
      : -1;

  const unansweredRequestCallIds = new Set<string>();
  for (const entry of calls.values()) {
    const callIndex = entry.requestCallIndex;
    if (callIndex === undefined) continue;
    const answers = resultIndicesById.get(entry.id) ?? [];
    if (!answers.some((index) => index > callIndex)) {
      unansweredRequestCallIds.add(entry.id);
    }
  }

  return {
    calls,
    results,
    trailingResultIds: results
      .filter((result) => result.trailing && result.toolCallId)
      .map((result) => result.toolCallId!),
    clientAnswers,
    hasNewerUserMessage:
      lastAnswerIndex >= 0 &&
      messages.slice(lastAnswerIndex + 1).some((msg) => msg?.role === "user"),
    unreplayableAnswerIds: clientAnswers
      .filter((result) => !result.offeredHome)
      .map((result) => result.toolCallId!),
    unansweredRequestCallIds,
  };
}

/**
 * Convert ``RunAgentInput.messages`` to Strands native ``Messages``.
 *
 * Strands has only ``user`` and ``assistant`` roles; tool calls and tool
 * results live as ``toolUse`` / ``toolResult`` ContentBlocks. Reconciling
 * the cached agent's ``self.messages`` with this list before invoking
 * ``stream(undefined)`` ensures the LLM sees the real conversation state —
 * including frontend tool results — rather than a fresh prompt that
 * re-fires the same tool every turn.
 *
 * Multimodal content is routed through ``convertAguiContentToStrands`` so
 * image/document/video blocks reach the LLM intact across replay.
 *
 * Orphan tool results AND orphan tool calls are both dropped, as
 * ``convertMessagesForStrandsSeed`` drops them: providers reject a
 * ``toolResult`` with no answering ``toolUse`` and an unanswered ``toolUse``
 * just as flatly, so replaying either turns a turn the fallback prompt could
 * have carried into a generic provider failure. An abandoned frontend call or a
 * reload mid-round-trip is how a request comes to carry one.
 *
 * Which of the pair is orphaned is read off the resolved view rather than
 * re-derived here, so the decision that vetoes a replay dropping a client
 * answer and the drop itself cannot disagree.
 */
/**
 * Does this message content carry an attachment the converter should handle?
 *
 * One definition for all three conversion sites. They previously each spelled
 * this out, and two of the three dereferenced `item.type` on an element that
 * arrives off the wire, so a null in the array threw before the converter's
 * own guards could drop it.
 */
function _contentHasMedia(content: readonly unknown[]): boolean {
  return content.some((item) => {
    if (!item || typeof item !== "object") return false;
    const type = (item as { type?: unknown }).type;
    return (
      type === "image" ||
      type === "audio" ||
      type === "video" ||
      type === "document" ||
      // The deprecated form. Omitting it made the converter's binary branch
      // unreachable: the attachment was dropped before conversion, with no
      // report, and on the live turn the prompt was replaced by the empty
      // string that flattening a binary-only message produces.
      type === "binary"
    );
  });
}

async function _buildStrandsHistory(
  input_messages: AguiMessage[],
  turn: ResolvedTurn,
  log: Logger,
  fetchOptions?: MediaConversionOptions,
): Promise<Array<{ role: "user" | "assistant"; content: unknown[] }>> {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  const answerByIndex = new Map(
    turn.results.map((result) => [result.index, result] as const),
  );
  const messages = input_messages ?? [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex]!;
    const role = msg.role;
    if (role === "user") {
      const content: unknown[] = [];
      const raw = msg.content;
      if (Array.isArray(raw)) {
        const hasMedia = _contentHasMedia(raw);
        if (hasMedia) {
          try {
            const blocks = await convertAguiContentToStrands(
              raw as never,
              log,
              { ...fetchOptions, messageId: msg.id },
            );
            for (const b of blocks) {
              if (b instanceof TextBlock) {
                content.push({ text: b.text });
              } else {
                const serialised =
                  typeof (b as { toJSON?: () => unknown }).toJSON === "function"
                    ? (b as { toJSON: () => unknown }).toJSON()
                    : b;
                content.push(serialised);
              }
            }
          } catch (e) {
            log.warn(
              `${LOG_PREFIX} history replay multimodal conversion failed; falling back to text`,
              e,
            );
          }
          if (content.length === 0) {
            // An empty string here is rejected by the provider, which turns
            // one dead attachment URL into a thread that fails on every
            // subsequent run. The seed and live-turn paths both avoid it.
            const fallback = flattenContentToText(raw as never);
            if (fallback) content.push({ text: fallback });
          }
        } else {
          const text = flattenContentToText(raw as never);
          if (text) content.push({ text });
        }
      } else {
        const text = _coerceText(raw);
        if (text) content.push({ text });
      }
      // A turn that produced nothing still has to occupy its place. The
      // provider rejects an empty content array and a blank text block, but it
      // also rejects the assistant-first or consecutive-assistant history that
      // dropping this turn would leave behind, so the repair is the same
      // single space the document-only guard uses.
      if (content.length === 0) content.push({ text: " " });
      out.push({ role: "user", content });
    } else if (role === "assistant") {
      const blocks: unknown[] = [];
      const text = _coerceText(msg.content);
      if (text) blocks.push({ text });
      const rawToolCalls =
        (msg as { toolCalls?: AguiToolCall[] }).toolCalls ?? [];
      for (const tc of rawToolCalls) {
        const fn = tc.function as
          | { name?: string; arguments?: string }
          | undefined;
        const name = fn?.name || "unknown";
        const rawArgs = fn?.arguments || "{}";
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawArgs);
        } catch (e) {
          log.warn(
            `${LOG_PREFIX} history tool args JSON parse failed for ${name}; falling back to {}`,
            e,
          );
          parsed = {};
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        )
          parsed = {};
        if (!tc.id || turn.unansweredRequestCallIds.has(tc.id)) {
          log.warn(
            `${LOG_PREFIX} history replay dropped a tool call no replayed tool ` +
              `result answers: toolCallId=${tc.id}`,
          );
          continue;
        }
        blocks.push({
          toolUse: { toolUseId: tc.id, name, input: parsed },
        });
      }
      // A blank text block is rejected by the provider, so an assistant turn
      // with neither text nor tool calls keeps its place with a space rather
      // than an empty string.
      if (blocks.length === 0) blocks.push({ text: " " });
      out.push({ role: "assistant", content: blocks });
    } else if (role === "tool") {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId || "";
      if (!answerByIndex.get(messageIndex)?.offeredHome) {
        log.warn(
          `${LOG_PREFIX} history replay dropped a tool result no replayed tool ` +
            `call answers: toolCallId=${toolCallId}`,
        );
        continue;
      }
      // Derived by the same helper reconciliation writes its correction from,
      // rather than from `content` alone, so this path carries the client's
      // failure reason as well as its status: reading `content` alone answers a
      // failure with an empty body using the empty-result acknowledgement,
      // which asserts success under `status: "error"`.
      const { status, content } = clientResultFields(_clientResult(msg));
      out.push({
        role: "user",
        content: [
          {
            toolResult: { toolUseId: toolCallId, content: [content], status },
          },
        ],
      });
    }
  }
  return out;
}

/** Options accepted by `StrandsAgent`. */
export interface StrandsAgentOptions {
  /**
   * Either an `Agent` (the template — adapter clones it per thread and syncs
   * proxy tools) OR a multi-agent orchestrator (`Graph`, `Swarm`).
   * Orchestrators are stateless per invocation so the same instance serves
   * every thread.
   */
  agent: StrandsAgentCore | StrandsOrchestrator;
  name: string;
  description?: string;
  config?: StrandsAgentConfig;
  /**
   * Plugins forwarded to every per-thread Strands agent created by this
   * adapter (observability, loop caps, policy checks, ...). Mirrors the
   * Python adapter's `hooks=` kwarg. Ignored when `agent` is a multi-agent
   * orchestrator.
   */
  plugins?: Plugin[];
  /**
   * Optional external map for per-thread agent persistence. When provided,
   * the adapter uses this map instead of an internal one — allowing agent
   * instances (and their interrupt state) to survive across adapter
   * re-instantiations (e.g. request-scoped wrappers in serverless runtimes).
   */
  agentsByThread?: Map<string, StrandsAgentCore>;
}

/** AWS Strands Agent wrapper for AG-UI integration. */
export class StrandsAgent {
  readonly name: string;
  readonly description: string;
  readonly config: StrandsAgentConfig;

  // Template agent configuration for creating fresh per-thread instances.
  private readonly _templateFields: TemplateAgentCloneFields;

  /**
   * Template settings that will not reach per-thread agents.
   *
   * Both are reported the first time a per-thread agent is built, once the
   * caller's own per-thread config is known, and only for the ones that config
   * does not supply. Reporting at construction instead would either nag
   * callers who already handled these or stay quiet for the ones who handled
   * only part of them.
   *
   * They are kept apart because they deserve different volumes. A field the
   * caller demonstrably set and that will not be carried is worth a warning.
   * A field the SDK populates on every Agent whether or not anyone asked for
   * it, like the conversation manager, is not: warning about that would fire
   * at every caller including the ones who set nothing.
   */
  private _uncarriedSetFields: readonly string[] = [];
  private _uncarriedDefaultFields: readonly string[] = [];
  /**
   * Fields already reported.
   *
   * Tracked per field rather than as a single "have we reported yet" flag. The
   * hook runs per thread and may answer differently each time, so one thread
   * supplying everything must not buy silence for the next thread that
   * supplies nothing.
   */
  private readonly _reportedUncarried = new Set<string>();

  /**
   * Hook providers forwarded to each per-thread StrandsAgentCore.
   *
   * Taken directly from the caller rather than read off the template because
   * Strands' `Agent.hooks` is a `HookRegistry` containing only registered
   * callbacks — the original list of provider objects is not retained, and
   * the registry also contains callbacks bound to internal Strands objects
   * that must not be cross-wired into per-thread agents.
   */
  private readonly _plugins: Plugin[];

  private readonly _agentsByThread: Map<string, StrandsAgentCore>;
  private readonly _proxyToolNamesByThread = new Map<string, Set<string>>();
  /**
   * Guards first-time thread initialization. The sessionManagerProvider call
   * introduces an async yield point between the "is this thread new?" check
   * and the map assignment, so concurrent requests for the same new threadId
   * could otherwise both create an agent and one would clobber the other.
   */
  private readonly _threadInitLock = new AsyncMutex();
  /**
   * Threads with an in-flight run. Strands `Agent.stream()` throws if a
   * second invocation is started on a busy agent; we detect the collision
   * up front and emit a protocol-shaped RUN_ERROR/THREAD_BUSY instead.
   * Python refuses the same per-thread collision before entering its own run
   * body, with the same code and the same message text. It additionally
   * guards a shared orchestrator instance across every thread, since such an
   * instance cannot be multiplexed at all; that arm narrows back to per-thread
   * when a callable builds a fresh orchestrator per run. It also refuses a run
   * against an orchestrator parked at an interrupt.
   */
  private readonly _activeRunsByThread = new Set<string>();
  /** Outstanding AG-UI interrupt objects per thread, used to validate
   * incoming `RunAgentInput.resume[]` (interrupts.mdx rules 3-7). */
  private readonly _pendingInterruptsByThread = new Map<
    string,
    Map<string, AguiInterrupt>
  >();
  /** Fingerprint of last successfully-processed resume per thread (idempotency). */
  private readonly _lastResumeFingerprint = new Map<string, string>();

  /**
   * When non-null, the adapter bypasses per-thread cloning and invokes
   * the orchestrator directly. See `StrandsAgentOptions.agent`.
   */
  private readonly _orchestrator: StrandsOrchestrator | null;
  /**
   * Injectable logger. Defaults to console `warn`/`error` with `debug`
   * suppressed, matching Python's stdlib `logging.getLogger(__name__)`.
   */
  private readonly _log: Logger;

  constructor(options: StrandsAgentOptions) {
    const {
      agent,
      name,
      description = "",
      config = {},
      plugins,
      agentsByThread,
    } = options;

    this._agentsByThread = agentsByThread ?? new Map();

    // Detect a multi-agent orchestrator. Graph / Swarm expose `nodes` + `edges`
    // (Graph) or `nodes` + invoke semantics (Swarm) and have no `.model`
    // accessor — branching on the presence of `.model` is the cleanest
    // structural check.
    const isOrchestrator =
      typeof (agent as { model?: unknown }).model === "undefined" ||
      (agent as { model?: unknown }).model === null;

    this.name = name;
    this.description = description;
    this.config = config;
    this._log = resolveLogger(config.logger);

    if (isOrchestrator) {
      this._orchestrator = agent as StrandsOrchestrator;
      this._templateFields = { model: undefined as never, tools: [] };
      this._plugins = [];
      return;
    }

    this._orchestrator = null;
    const agentCore = agent as StrandsAgentCore;
    const extracted = _extractTemplateFields(agentCore);
    this._templateFields = extracted.fields;
    this._plugins = plugins ? [...plugins] : [];
    // Only fields whose value could actually be read are named here. Strands
    // consumes others into internal state during construction and keeps
    // nothing the adapter can find, so for those "was it set?" has no answer
    // from the outside and a guess would fire at callers who set nothing.
    // Those are documented on threadAgentConfig, which is the route that
    // carries them.
    this._uncarriedSetFields = [...extracted.unsupported].sort();
    this._uncarriedDefaultFields = [...extracted.ignored].sort();

    // Detect the common pitfall: sessionManager set on the template Agent
    // with no per-thread provider. Forwarding it would make every AG-UI
    // thread share one session_id.
    if (agentCore.sessionManager && !this.config.sessionManagerProvider) {
      this._log.warn(
        `${LOG_PREFIX} sessionManager was set on the template Agent but will ` +
          "be ignored: forwarding it would cause every AG-UI thread to share the " +
          "same session_id. Construct per-thread session managers via " +
          "StrandsAgentConfig.sessionManagerProvider instead.",
      );
    }

    // Detect MCP clients passed directly into `tools: [...]`, whose tools are
    // therefore absent from the resolved list this adapter clones.
    //
    // Strands routes an `McpClient` out of `tools` into an internal client
    // list rather than into the tool registry, and registers its tools only
    // inside `Agent.initialize()`, which runs on the first invocation. The
    // template Agent is never invoked, so the `agent.tools` list cloned onto
    // every per-thread agent never gains them. Connecting the client first
    // changes nothing, because `listTools()` connects lazily; the distinction
    // is resolved-versus-unresolved, not connected-versus-unconnected.
    //
    // The client list is private, so it is read through `_readTemplateField`,
    // which tries the public name before the underscore one and returns
    // `undefined` rather than throwing when neither is there.
    const templateMcpClients = _readTemplateField(agentCore, "mcpClients");
    if (Array.isArray(templateMcpClients) && templateMcpClients.length > 0) {
      this._log.warn(
        `${LOG_PREFIX} the template Agent's \`tools\` holds ` +
          `${templateMcpClients.length} McpClient ` +
          `${templateMcpClients.length === 1 ? "entry" : "entries"} whose ` +
          "tools are not in `agent.tools`, so they will not be available to " +
          "the model. Resolve them yourself and spread the result in: " +
          "`await client.connect()`, then `tools: [...(await " +
          "client.listTools())]`. Drop the client from `tools` once you do.",
      );
    }
  }

  /**
   * Ensure a Strands agent exists for the given thread. Creates one if needed
   * (including session manager initialization). Returns the agent or an error
   * event to yield. Called from `run()`'s resume-validation gate on a cold
   * start with a session provider (so SessionManager can restore
   * `_interruptState` before validation runs), and again from
   * `_runSingleAgent` for the actual run — the second call is a cache hit.
   */
  private async _ensureAgent(
    inputData: RunAgentInput,
    threadId: string,
    fetchOptions?: MediaConversionOptions,
  ): Promise<{ agent: StrandsAgentCore } | { error: BaseEvent }> {
    let strandsAgent = this._agentsByThread.get(threadId);
    if (strandsAgent) return { agent: strandsAgent };

    // Build seed outside the lock (may do async fetches for multimodal).
    let seedMessages: AgentConfig["messages"] | undefined;
    if (!this.config.sessionManagerProvider) {
      try {
        seedMessages = await buildStrandsSeed(
          inputData.messages ?? [],
          this._log,
          fetchOptions,
        );
      } catch (e) {
        this._log.error(
          `${LOG_PREFIX} buildStrandsSeed failed for thread ${threadId}: ${_errorMessage(e)}`,
          e,
        );
        return {
          error: _runError(
            "Failed to build conversation seed: " + _errorMessage(e),
            "SEED_BUILD_ERROR",
          ),
        };
      }
    }

    const release = await this._threadInitLock.acquire();
    try {
      strandsAgent = this._agentsByThread.get(threadId);
      if (strandsAgent) return { agent: strandsAgent };

      let sessionManager: SessionManager | null | undefined;
      if (this.config.sessionManagerProvider) {
        try {
          sessionManager = (await maybeAwait(
            this.config.sessionManagerProvider(inputData),
          )) as SessionManager | null | undefined;
        } catch (e) {
          const msg = _errorMessage(e);
          this._log.error(
            `${LOG_PREFIX} sessionManagerProvider failed: ${msg}`,
            e,
          );
          return {
            error: _runError(
              `Failed to initialize session manager: ${msg}`,
              "SESSION_MANAGER_ERROR",
            ),
          };
        }
        if (
          sessionManager != null &&
          !(sessionManager instanceof SessionManager) &&
          typeof (sessionManager as { initAgent?: unknown }).initAgent !==
            "function"
        ) {
          const actual =
            (sessionManager as object)?.constructor?.name ??
            typeof sessionManager;
          this._log.error(
            `${LOG_PREFIX} sessionManagerProvider returned ${actual}; expected a SessionManager instance.`,
          );
          return {
            error: _runError(
              `sessionManagerProvider returned ${actual}; expected a SessionManager instance`,
              "SESSION_MANAGER_INVALID_TYPE",
            ),
          };
        }
        if (!sessionManager) {
          this._log.warn(
            `${LOG_PREFIX} sessionManagerProvider returned null/undefined for threadId=${threadId}; agent will run without session persistence`,
          );
        }
      }
      let callerConfig: Partial<AgentConfig> | undefined;
      if (this.config.threadAgentConfig) {
        try {
          callerConfig = await maybeAwait(
            this.config.threadAgentConfig(inputData),
          );
        } catch (e) {
          const msg = _errorMessage(e);
          this._log.error(`${LOG_PREFIX} threadAgentConfig failed: ${msg}`, e);
          return {
            error: _runError(
              `Failed to build per-thread agent config: ${msg}`,
              "THREAD_AGENT_CONFIG_ERROR",
            ),
          };
        }
      }
      this._reportUncarried(callerConfig);
      const effectiveSeed = sessionManager ? undefined : seedMessages;
      strandsAgent = new StrandsAgentCore(
        this._buildThreadAgentConfig(
          sessionManager ?? undefined,
          effectiveSeed,
          callerConfig,
        ),
      );
      // Re-narrow the per-request tool filter once a tool batch has run. The
      // parked-batch exemption holds a denied tool registered so a resume can
      // reach it, and Strands then continues the same run against the same
      // registry; without this the run would keep advertising what the request
      // denied until the next request narrowed again.
      //
      // `AfterToolsEvent`, not `BeforeModelCallEvent`: this SDK reads the tool
      // specs off the registry as the first statement of its model call and
      // dispatches `BeforeModelCallEvent` after, so a hook there would narrow
      // the registry a moment too late to affect the specs it was narrowing
      // for. Python's loop dispatches before that read, and its half of this
      // hook uses `BeforeModelCallEvent`; it has no `AfterToolsEvent` to use.
      if (this.config.templateToolsProvider) {
        const built = strandsAgent;
        built.addHook(AfterToolsEvent, () => {
          renarrowTemplateTools(
            built,
            this._templateFields.tools ?? [],
            this._log,
          );
        });
      }

      // Register interruptOnCall hooks on the per-thread agent.
      const behaviors = this.config.toolBehaviors;
      if (behaviors) {
        for (const [toolName, behavior] of Object.entries(behaviors)) {
          if (behavior.interruptOnCall) {
            strandsAgent.addHook(BeforeToolCallEvent, (event) => {
              if (event.toolUse?.name === toolName) {
                if (isProxyTool(event.tool)) {
                  this._log.warn(
                    `${LOG_PREFIX} interruptOnCall is ignored for client-provided tool "${toolName}"; gate execution in the client.`,
                  );
                  return;
                }
                const response = event.interrupt({
                  name: `${TOOL_APPROVAL_NAME_PREFIX}${toolName}`,
                  reason: {
                    tool_call: true,
                    tool_name: toolName,
                    tool_input: event.toolUse!.input ?? {},
                    tool_use_id: event.toolUse!.toolUseId,
                  },
                });
                if (
                  response == null ||
                  typeof response !== "object" ||
                  (response as Record<string, unknown>).approved !== true
                ) {
                  event.cancel = `User denied approval for '${toolName}'.`;
                }
              }
            });
          }
        }
      }
      // SessionManager restores snapshots from its InitializedEvent hook. Run
      // initialization now, before `run()` validates a cold-start resume;
      // `stream()` otherwise initializes too late, after validation has
      // rejected the restored interrupt IDs as unknown.
      if (sessionManager) {
        try {
          const initialize = (
            strandsAgent as unknown as { initialize?: () => Promise<void> }
          ).initialize;
          if (typeof initialize === "function") {
            await initialize.call(strandsAgent);
          }
        } catch (e) {
          const msg = _errorMessage(e);
          this._log.error(
            `${LOG_PREFIX} failed to initialize session manager for thread ${threadId}: ${msg}`,
            e,
          );
          return {
            error: _runError(
              `Failed to initialize session manager: ${msg}`,
              "SESSION_MANAGER_ERROR",
            ),
          };
        }
      }
      this._agentsByThread.set(threadId, strandsAgent);
      return { agent: strandsAgent };
    } finally {
      release();
    }
  }

  /** Run the Strands agent and yield AG-UI events. */
  async *run(inputData: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    const threadId = inputData.threadId || "default";
    const hasResume =
      Array.isArray(inputData.resume) && inputData.resume.length > 0;

    // Computed during validation; stored only after successful processing.
    let fingerprint: string | undefined;

    // interrupts.mdx rules 2-7: validate resume entries against pending
    // interrupts. Gated above `_runRaw` so subclasses that override only
    // `_runRaw` still inherit the checks.
    if (hasResume) {
      // Rule 5: idempotency — detect replayed resumes
      fingerprint = resumeFingerprint(inputData.resume!);

      // The SDK's interrupt state is the only record of what is still in
      // flight. A cold process has nothing cached for this thread, so restore
      // the per-thread agent first: SessionManager brings the checkpoint back
      // with it.
      let strandsAgent = this._agentsByThread.get(threadId);
      if (!strandsAgent && this.config.sessionManagerProvider) {
        const restored = await this._ensureAgent(inputData, threadId);
        if ("error" in restored) {
          yield _runStarted(inputData);
          yield restored.error;
          return;
        }
        strandsAgent = restored.agent;
      }

      // The AG-UI metadata and the idempotency fingerprint are this adapter's
      // own, and a restart loses the in-process copy while SessionManager still
      // restores the checkpoint, so read what was persisted beside it (see
      // loadPersistedInterruptBookkeeping doc above) whenever this process holds
      // none.
      if (
        strandsAgent &&
        !this._pendingInterruptsByThread.get(threadId)?.size
      ) {
        const { pending: persistedPending, fingerprint: persistedFingerprint } =
          loadPersistedInterruptBookkeeping(strandsAgent);
        if (persistedPending) {
          this._pendingInterruptsByThread.set(threadId, persistedPending);
        }
        if (
          persistedFingerprint &&
          !this._lastResumeFingerprint.has(threadId)
        ) {
          this._lastResumeFingerprint.set(threadId, persistedFingerprint);
        }
      }

      const interruptState = (
        strandsAgent as
          | { _interruptState?: { activated?: boolean; interrupts?: unknown } }
          | undefined
      )?._interruptState;
      const checkpointActive = interruptState?.activated === true;
      const open = checkpointActive
        ? _openNativeInterrupts(interruptState!.interrupts)
        : new Map<string, unknown>();

      // An active checkpoint whose every interrupt is answered is a thread the
      // SDK parked mid-resume (see _replaysRecordedAnswers). Only an exact
      // replay gets out of it, and it has to reach Strands to do so.
      const replayingParkedResume =
        checkpointActive &&
        _replaysRecordedAnswers(interruptState!.interrupts, inputData.resume!);

      // Rule 5: idempotency. A replayed resume the thread already completed is
      // answered from the fingerprint. A parked resume has not completed, so
      // answering it here would report success while the checkpoint never
      // advances.
      if (
        !replayingParkedResume &&
        this._lastResumeFingerprint.get(threadId) === fingerprint
      ) {
        yield _runStarted(inputData);
        yield {
          type: EventType.RUN_FINISHED,
          threadId: inputData.threadId,
          runId: inputData.runId,
          outcome: { type: "success" },
        };
        return;
      }

      // The interrupts this resume may address: normally the open ones, or the
      // answered ones a parked resume is replaying.
      const addressable = replayingParkedResume
        ? _nativeInterruptsById(interruptState!.interrupts)
        : open;

      if (addressable.size === 0) {
        yield _runStarted(inputData);
        yield _runError(
          "No pending interrupts for this thread.",
          "UNKNOWN_INTERRUPT_ID",
        );
        return;
      }

      // Rule 2: reject unknown interrupt IDs
      const unknown = inputData
        .resume!.map((entry) => entry.interruptId)
        .filter((id) => !addressable.has(id));
      if (unknown.length > 0) {
        yield _runStarted(inputData);
        yield _runError(
          `This agent did not issue any interrupts to resume: ${unknown
            .slice(0, 4)
            .join(", ")}. ` +
            "Resume entries must reference an outstanding interruptId.",
          "UNKNOWN_INTERRUPT_ID",
        );
        return;
      }

      // Rule 3: all open interrupts must be addressed
      const resumedIds = new Set(inputData.resume!.map((e) => e.interruptId));
      const missing = [...addressable.keys()].filter(
        (id) => !resumedIds.has(id),
      );
      if (missing.length > 0) {
        yield _runStarted(inputData);
        yield _runError(
          `Partial resume: missing interrupt IDs: ${missing.sort().join(", ")}. ` +
            "All open interrupts must be addressed.",
          "PARTIAL_RESUME",
        );
        return;
      }

      // Rules 6 and 7 read what the SDK has nowhere for: the answer shape
      // advertised to the client, and an expiry. A restart can lose that
      // record, and a tool approval's contract is fixed, so the SDK's own
      // interrupt supplies the schema when the record cannot.
      const recorded = this._pendingInterruptsByThread.get(threadId);
      for (const entry of inputData.resume!) {
        const metadata = recorded?.get(entry.interruptId);

        // Rule 7: expiresAt enforcement
        if (metadata?.expiresAt && new Date() > new Date(metadata.expiresAt)) {
          yield _runStarted(inputData);
          yield _runError(
            `Interrupt '${entry.interruptId}' has expired.`,
            "INTERRUPT_EXPIRED",
          );
          return;
        }

        // Rule 6: basic payload validation against responseSchema. Skipping it
        // for a tool approval would forward a falsy payload raw, Strands would
        // record it as "no answer", and the same interrupt would re-raise
        // forever.
        if (entry.status !== "resolved") continue;
        const schema =
          (metadata?.responseSchema as Record<string, unknown> | undefined) ??
          (isToolApprovalInterrupt(addressable.get(entry.interruptId))
            ? toolApprovalResponseSchema()
            : undefined);
        if (!schema) continue;
        const payloadError = validateResumePayload(entry, schema);
        if (payloadError) {
          yield _runStarted(inputData);
          yield payloadError;
          return;
        }
      }

      // fingerprint is stored after successful processing (below).
    } else {
      // Rule 4: pending interrupts block new input without resume.
      // Per spec, clients must address all pending interrupts via resume[].
      // To abandon interrupts, send resume with all entries status: "cancelled".
      // The SDK owns the checkpoint, so one it still holds active blocks the
      // turn and is left exactly as it stands: clearing it here would discard
      // the tool execution parked behind it.
      let interruptState: unknown;
      const cached = this._agentsByThread.get(threadId);
      if (cached) {
        interruptState = (cached as { _interruptState?: unknown })
          ._interruptState;
      } else if (this.config.sessionManagerProvider) {
        // A cold process has no cached agent yet, but SessionManager may
        // restore a native pending interrupt for this thread. Restore it
        // before deciding whether new input may proceed (Rule 4).
        const restored = await this._ensureAgent(inputData, threadId);
        if ("error" in restored) {
          yield _runStarted(inputData);
          yield restored.error;
          return;
        }
        interruptState = (restored.agent as { _interruptState?: unknown })
          ._interruptState;
      }
      if (
        (interruptState as { activated?: boolean } | null | undefined)
          ?.activated === true
      ) {
        yield _runStarted(inputData);
        yield _runError(
          "Thread has pending interrupts. Include resume[] to address them.",
          "PENDING_INTERRUPTS",
        );
        return;
      }
    }
    // Run the agent. Track whether an error was emitted so we only store
    // the idempotency fingerprint after successful processing.
    let hadError = false;
    let pausedSilently = false;
    // A resume that ends on a NEW interrupt has not completed the turn it was
    // answering, so it must not be remembered as a finished resume. The
    // interrupt branch clears the fingerprint and persists the new interrupt
    // deliberately; storing either here would undo both, and an exact retry of
    // the stale batch would then be answered from the fingerprint with a
    // success the client can act on while the tool stays parked for good.
    let rePaused = false;
    const source = this._runRaw(inputData);
    const tracked = (async function* () {
      for await (const ev of source) {
        const kind = (ev as { type: string }).type;
        if (kind === EventType.RUN_ERROR) hadError = true;
        if (
          kind === EventType.RUN_FINISHED &&
          (ev as { outcome?: { type?: string } }).outcome?.type === "interrupt"
        ) {
          rePaused = true;
        }
        // Read off this run's own finish event, the same way `rePaused` is.
        // Nothing else can reach it, so no other run can consume or clear it.
        if (
          kind === EventType.RUN_FINISHED &&
          (ev as Record<symbol, unknown>)[PAUSED_PARKED] === true
        ) {
          pausedSilently = true;
        }
        yield ev;
      }
    })();
    if (this.config.emitChunkEvents) {
      yield* collapseToChunkEvents(tracked);
    } else {
      yield* tracked;
    }
    if (!hadError && !rePaused && !pausedSilently && fingerprint) {
      this._lastResumeFingerprint.set(threadId, fingerprint);
      const strandsAgent = this._agentsByThread.get(threadId);
      if (strandsAgent) {
        persistInterruptBookkeeping(strandsAgent, null, fingerprint, this._log);
      }
    }
  }

  protected async *_runRaw(
    inputData: RunAgentInput,
  ): AsyncGenerator<BaseEvent, void, void> {
    const threadId = inputData.threadId || "default";

    // Reject concurrent runs on the same thread up front. Strands cannot
    // multiplex a single Agent across invocations and emits a confusing
    // internal error ("Agent is already processing an invocation") if we try.
    if (this._activeRunsByThread.has(threadId)) {
      yield _runStarted(inputData);
      yield _runError(
        `Another run is already in progress on ${_busyScope(threadId)}. ` +
          "Wait for RUN_FINISHED before starting another.",
        "THREAD_BUSY",
      );
      return;
    }
    this._activeRunsByThread.add(threadId);
    try {
      if (this._orchestrator !== null) {
        yield* this._runOrchestrator(inputData, threadId);
      } else {
        yield* this._runSingleAgent(inputData, threadId);
      }
    } finally {
      this._activeRunsByThread.delete(threadId);
    }
  }

  private async *_runSingleAgent(
    inputData: RunAgentInput,
    threadId: string,
  ): AsyncGenerator<BaseEvent, void, void> {
    // Covers the whole run, including the seed's attachment downloads, which
    // an inner `finally` did not reach.
    //
    // What this does NOT do is cancel a download on client disconnect. The
    // endpoint signals a disconnect by calling `return()` on this generator,
    // and a generator parked inside an `await` cannot be interrupted that way:
    // the call queues behind whatever is in flight. Every media fetch happens
    // inside such an await. The signal is wired through to the fetch and does
    // cancel it when something aborts mid-flight, but nothing reaches it from
    // a disconnect; that needs a cancellation channel independent of
    // generator abandonment. `multimodal-run-egress` pins the current limit.
    const runAbort = new AbortController();
    try {
      yield* this._runSingleAgentInner(inputData, threadId, runAbort);
    } finally {
      runAbort.abort();
    }
  }

  /** Tell the client which attachments did not reach the model, and why. */
  private async *_reportDroppedMedia(
    dropped: DroppedMedia[],
    delivered: number,
  ): AsyncGenerator<BaseEvent, void, void> {
    if (dropped.length === 0) return;
    yield {
      type: EventType.CUSTOM,
      name: "MediaDropped",
      value: {
        dropped: dropped.map((d) => ({ type: d.type, reason: d.reason })),
        delivered,
      },
    } as BaseEvent;
  }

  private async *_runSingleAgentInner(
    inputData: RunAgentInput,
    threadId: string,
    runAbort: AbortController,
  ): AsyncGenerator<BaseEvent, void, void> {
    // Set only by the pause below, and read only by the finish this method
    // yields, so the two cannot be separated by anything.
    let pausedWithNothingToReport = false;
    yield _runStarted(inputData);

    // One memo for the whole run. A cold run converts the same turns more than
    // once (construction seed, then replayed history), so without this every
    // remote attachment in the thread is downloaded once per conversion.
    const fetchCache = createUrlFetchCache();

    // Checked once here, not per attachment, and before the first fetch.
    // `fetchUrlContent` refuses an unusable policy too, but the replay path
    // converts inside a try/catch that reports a throw as "conversion failed;
    // falling back to text", so a misconfigured adapter would otherwise show
    // up as messages quietly stripped of their attachments, once per message,
    // with the reason only in a log line. A configuration mistake belongs to
    // the run, so it ends the run and says which field is wrong. The one thing
    // it must never do is fall back to the default policy: that would ignore
    // an intended restriction.
    //
    // Single-agent runs only. The orchestrator path takes text alone (see the
    // prompt extraction in `_runOrchestrator`), so it fetches nothing and has
    // no policy to check.
    const urlFetchPolicy = this.config.urlFetchPolicy;
    if (urlFetchPolicy !== undefined) {
      try {
        assertUsablePolicy(urlFetchPolicy);
      } catch (e) {
        const msg = _errorMessage(e);
        this._log.error(
          `${LOG_PREFIX} config.urlFetchPolicy is unusable: ${msg}`,
          e,
        );
        yield _runError(
          `Unusable urlFetchPolicy: ${msg}`,
          "URL_FETCH_POLICY_INVALID",
        );
        return;
      }
    }

    const fetchOptions = {
      fetchCache,
      signal: runAbort.signal,
      urlFetchPolicy,
    };

    // Get or create agent instance for this thread.
    const agentResult = await this._ensureAgent(
      inputData,
      threadId,
      fetchOptions,
    );
    if ("error" in agentResult) {
      yield agentResult.error;
      return;
    }
    const strandsAgent = agentResult.agent;

    // Filter the tools the template contributed, per request. Applied to the
    // registry this thread's live agent already owns: that instance carries the
    // thread's session manager, its interrupt checkpoint and its history, so
    // rebuilding it to change a tool list would discard a conversation and any
    // approval waiting inside it.
    if (this.config.templateToolsProvider) {
      // Calling the provider and reading its answer are guarded together.
      // Reading is where a Map, a bare name or a generator that throws partway
      // through is caught, and those are provider mistakes: leaving them
      // outside this arm let them bypass the documented code and end the
      // stream after RUN_STARTED with nothing terminal behind it.
      let allowed: Set<string> | null;
      try {
        const selection: TemplateToolSelection = await maybeAwait(
          this.config.templateToolsProvider(inputData),
        );
        allowed = resolveTemplateToolSelection(
          selection,
          indexTemplateTools(this._templateFields.tools ?? []),
          this._log,
        );
      } catch (e) {
        const msg = _errorMessage(e);
        this._log.error(
          `${LOG_PREFIX} templateToolsProvider failed: ${msg}`,
          e,
        );
        // Deliberately terminal rather than unfiltered: a filter that fails
        // open hands the model tools the caller meant to withhold.
        yield _runError(
          `Failed to resolve the template tools for this request: ${msg}`,
          "TEMPLATE_TOOLS_PROVIDER_ERROR",
        );
        return;
      }
      // Guarded separately, and not as a provider error: past this point a
      // failure is this adapter's, and this block runs before the main
      // try/catch below, so it still must not escape as a stream that stops
      // with nothing terminal behind it.
      try {
        applyTemplateToolSelection(
          strandsAgent.toolRegistry,
          this._templateFields.tools ?? [],
          allowed,
          {
            exemptNames: parkedBatchToolNames(strandsAgent),
            log: this._log,
          },
        );
        // Published for the re-narrowing hook: the exemption above holds a
        // denied tool registered so a resume can reach it, and Strands then
        // continues the same run from this registry.
        recordTemplateToolSelection(strandsAgent, allowed);
      } catch (e) {
        const msg = _errorMessage(e);
        this._log.error(
          `${LOG_PREFIX} applying the template tool filter failed: ${msg}`,
          e,
        );
        yield _runError(msg, _terminalErrorCode(e));
        return;
      }
    }

    // Sync proxy tools from client-defined tools.
    if (inputData.tools && inputData.tools.length > 0) {
      const proxyNames = syncProxyTools(
        strandsAgent.toolRegistry,
        inputData.tools,
        this._proxyToolNamesByThread.get(threadId) ?? new Set(),
        this._log,
      );
      this._proxyToolNamesByThread.set(threadId, proxyNames);
    } else {
      const previous = this._proxyToolNamesByThread.get(threadId);
      if (previous && previous.size > 0) {
        syncProxyTools(strandsAgent.toolRegistry, [], previous, this._log);
        this._proxyToolNamesByThread.set(threadId, new Set());
      }
    }

    // A2UI auto-injection. When the runtime forwards
    // `injectA2UITool` (or the host opts in via config), register a
    // `generate_a2ui` recovery tool bound to this agent's model and drop the
    // injected `render_a2ui` proxy so the model calls generate_a2ui directly.
    // `planA2UIInjection` returns null when injection is off, the model can't be
    // inferred (orchestrator), or the dev already wired generate_a2ui.
    // Wrapped so a failure here can NEVER escape after RUN_STARTED with no
    // terminal RUN_ERROR (this block runs before the main try/catch below).
    // Auto-injection is best-effort: if it throws, log and run without A2UI
    // rather than crashing the turn.
    //
    // What the model will be told about the application's context this run.
    // Starts as the whole of `RunAgentInput.context` and is narrowed below
    // when A2UI auto-injection actually happens, the way Python narrows
    // `model_context` from `agui_context`. Tools and hooks keep reading the
    // unnarrowed context through `buildContextExtras`.
    let modelContext = normalizeAguiContext(inputData.context);
    try {
      const registry = strandsAgent.toolRegistry;
      // Auto-inject requires enumerating the registry to (a) remove our OWN
      // prior-turn tool so the refresh carries THIS turn's messages/state, and
      // (b) honor USER-PREVAILS (never touch a dev-wired generate_a2ui). Without
      // `list()` we can do neither safely, so SKIP rather than risk clobbering a
      // developer's tool. The real @strands-agents/sdk ToolRegistry always
      // provides list(); this guard is a fail-loud backstop for alternates.
      if (typeof registry.list !== "function") {
        const wantsInject =
          (inputData.forwardedProps as { injectA2UITool?: unknown } | undefined)
            ?.injectA2UITool ?? this.config.a2ui?.injectA2UITool;
        if (wantsInject) {
          this._log.warn(
            "[@ag-ui/aws-strands] A2UI tool injection requested but toolRegistry.list() " +
              "is unavailable; skipping auto-injection for this run.",
          );
        }
      } else {
        for (const t of registry.list()) {
          if (isAutoInjectedA2UITool(t)) registry.remove(t.name);
        }
        const existingToolNames = registry.list().map((t) => t.name);
        const plan = planA2UIInjection({
          model: (strandsAgent as { model?: unknown }).model ?? null,
          input: inputData,
          existingToolNames,
          config: this.config.a2ui,
          log: this._log,
        });
        if (plan) {
          for (const name of plan.dropToolNames) registry.remove(name);
          registry.add(plan.tool);
          // The middleware also supplies a usage guide for the render proxy.
          // Once that proxy is replaced with `generate_a2ui`, the guide is
          // stale and must reach neither the outer model nor the recovery
          // subagent (which `planA2UIInjection` narrows for itself).
          modelContext = withoutA2UIRenderGuides(
            modelContext,
            plan.dropToolNames,
          );
        }
      }
    } catch (e) {
      this._log.warn(
        `[@ag-ui/aws-strands] A2UI auto-injection failed; running without A2UI for this turn: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // Provider-reported usage, one entry per model call, aggregated onto this
    // run's terminal event. A local rather than per-thread state, so it is
    // seeded per run by construction: a second sequential run on the same
    // thread enters this method again and cannot inherit the first's counts.
    //
    // Declared outside the try so the terminal RUN_ERROR in its catch reports
    // the spend a failed run had already made.
    const runUsage: TokenUsage[] = [];
    // One read of the model's labels for the whole run: the per-thread agent's
    // model is fixed for the invocation, and `modelMetadataEvent` carries usage
    // without saying which model produced it.
    const modelIdentity = strandsModelIdentity(
      (strandsAgent as { model?: unknown }).model,
    );

    try {
      // Seed the running ``MessagesSnapshotEvent`` payload from the full
      // conversation history so each emitted snapshot carries prior turns
      // plus whatever this turn adds.
      const emitMessagesSnapshot = this.config.emitMessagesSnapshot !== false;
      const snapshotMessages: AguiMessage[] = emitMessagesSnapshot
        ? buildSnapshotMessages(inputData.messages ?? [])
        : [];

      // Emit state snapshot if provided. Filter out `messages` from state to
      // avoid "Unknown message role" errors — the frontend manages messages
      // separately and doesn't recognize the "tool" role.
      const initialSnapshot = _stateSnapshotPayload(inputData.state);
      if (initialSnapshot !== undefined) {
        yield { type: EventType.STATE_SNAPSHOT, snapshot: initialSnapshot };
      }

      // Splice point 1 of 4: emit the initial messages snapshot so the
      // frontend can render the seeded thread before any new content streams.
      if (emitMessagesSnapshot && snapshotMessages.length > 0) {
        yield {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: snapshotMessages.slice(),
        };
      }

      const frontendToolNames = new Set<string>();
      for (const t of inputData.tools ?? []) {
        if (t.name) frontendToolNames.add(t.name);
      }

      // The ids of the frontend calls this adapter emitted, read back from app
      // state (restored from the store on a fresh process). Read here rather
      // than at the reconciliation block below because the resolved view needs
      // it too: it is one of the two signals of who executed a tool result on a
      // delta-only payload. Kept in persisted order, which the emission-time
      // size cap relies on to drop the oldest entries first.
      const sessionManager = strandsAgent.sessionManager;
      let clientCallIds: string[] = [];
      let reconciliationSetupError: unknown;
      if (sessionManager) {
        try {
          clientCallIds = recordedFrontendCallIds(strandsAgent);
        } catch (e) {
          reconciliationSetupError = e;
        }
      }
      const clientExecutedIds = new Set(clientCallIds);

      // The other signal: a stored or parked result this adapter's own proxy
      // wrote. It outlives the recorded id, which the emission-time size cap can
      // evict, so it is what keeps a delta-only continuation from filing the
      // client's answer as backend context. Provenance only -- admission still
      // reads `clientExecutedIds`, because only a recorded id may be retired
      // once its placeholder is corrected.
      const stubbedCallIds = sessionManager
        ? proxyPlaceholderProvenanceIds(strandsAgent)
        : new Set<string>();

      // Results a `resume[]` addresses through their interrupt. In scope for
      // this turn however far from the end of the request they sit, so the view
      // has to know before it decides which results are client answers.
      const resumeBoundResultIds = new Set<string>();
      {
        const priorPending = this._pendingInterruptsByThread.get(threadId);
        for (const entry of resolveResumeEntries(inputData)) {
          const toolCallId = priorPending?.get(entry.interruptId)?.toolCallId;
          if (toolCallId) resumeBoundResultIds.add(toolCallId);
        }
      }

      // ONE resolved view of this turn's tool calls, read by the orphan drop in
      // `_buildStrandsHistory`, the tool-name lookup, the admission test, the
      // provenance signal and the continuation decision alike.
      const turnToolCalls = _resolveTurnToolCalls({
        messages: inputData.messages ?? [],
        nativeMessages: [
          ...((strandsAgent as { messages?: unknown[] }).messages ?? []),
          ..._parkedAssistantMessages(strandsAgent),
        ],
        frontendToolNames,
        recordedCallIds: clientExecutedIds,
        stubbedCallIds,
        resumeBoundResultIds,
      });

      // Tool calls whose result the request already carries, so the stream
      // below suppresses duplicate TOOL_CALL_START events for them.
      const pendingToolResultIds = new Set(turnToolCalls.trailingResultIds);
      if (pendingToolResultIds.size > 0) {
        this._log.debug(
          `${LOG_PREFIX} Has pending tool results detected: toolCallIds=${JSON.stringify([...pendingToolResultIds])}, threadId=${inputData.threadId}`,
        );
      }

      /** Record a newly emitted frontend call so a later run can admit it. */
      const recordFrontendCall = (toolUseId: string): void => {
        // Only maintained when a session manager is actually active for this
        // agent (matching the continuation read/prune gate); otherwise nothing
        // would ever read it back.
        if (!sessionManager) return;
        recordFrontendCallId(strandsAgent, toolUseId);
      };

      // Derive the outgoing user message. For continuation runs (pending
      // tool results in history), synthesise a "frontend tool executed"
      // message so the model understands the context.
      let userMessage: string | ContentBlock[] = "Hello";
      // Attachments on the live turn that could not be delivered. Reported
      // below so a client can tell a partial delivery from a turn that
      // carried no attachments at all.
      let droppedMedia: DroppedMedia[] = [];
      // Trailing tool results this derivation could not name. Whether that is
      // fatal depends on which prompt the run ends up sending, which is only
      // settled once `invokeArgs` is, so the report waits until then.
      let unnameableResultIds: string[] = [];
      // The trailing prompt line by line, each tagged with the answer it says.
      // Kept rather than only joined because a reconcile can correct SOME of
      // this turn's answers and decline others, and the lines whose answer the
      // corrected history now carries have to come back out: restating one there
      // tells the model the same answer twice.
      const trailingPromptLines: Array<{
        toolCallId: string | undefined;
        line: string;
      }> = [];
      if (pendingToolResultIds.size > 0 && inputData.messages) {
        // Collect EVERY trailing tool result, not just the last: a parallel
        // frontend-tool turn resolves N results in one continuation run and
        // the model has to see all of the answers.
        const resultParts: string[] = [];
        const unresolvedResultIds: string[] = [];
        for (const answer of turnToolCalls.results) {
          if (!answer.trailing) continue;
          const toolCallId = answer.toolCallId;
          const name = answer.name;
          if (!name) {
            // Neither the input messages nor the native session history name
            // this call. Guessing stays off the table: with several frontend
            // tools declared, picking one feeds the model false context.
            // Collected rather than skipped, because skipping leaves the
            // prompt a bare greeting and the model re-fires the tool. What that
            // costs is the decision's to settle: fatal wherever the run has to
            // say what came back, harmless where replayed history carries the
            // result in its own block.
            if (toolCallId) unresolvedResultIds.push(toolCallId);
            this._log.warn(
              `${LOG_PREFIX} Could not resolve tool name for toolCallId=${toolCallId} ` +
                "from input messages or session history (delta-only payload). " +
                "The run fails closed unless replayed history carries the result.",
            );
            continue;
          }
          if (!answer.isClientAnswer) {
            // Named, but neither signal says frontend: not in the current
            // declarations and no recorded id. That is a tool Strands ran
            // itself, so the model already has it in the native history and
            // the continuation prompt has nothing to carry.
            this._log.debug(
              `${LOG_PREFIX} Skipping non-frontend tool result in the continuation ` +
                `message: toolName=${name}, toolCallId=${toolCallId}`,
            );
            continue;
          }
          const line = _continuationResultLine(name, answer.result);
          resultParts.push(line);
          trailingPromptLines.push({ toolCallId, line });
        }
        if (unresolvedResultIds.length > 0) {
          unnameableResultIds = unresolvedResultIds;
        } else if (resultParts.length > 0) {
          userMessage = resultParts.join("\n");
        }
      } else if (inputData.messages) {
        for (let i = inputData.messages.length - 1; i >= 0; i--) {
          const msg = inputData.messages[i];
          if (!msg) break;
          if (
            (msg.role === "user" || msg.role === "tool") &&
            msg.content != null
          ) {
            if (Array.isArray(msg.content)) {
              const hasMedia = _contentHasMedia(msg.content);
              if (hasMedia) {
                const { blocks, dropped } =
                  await convertAguiContentToStrandsDetailed(
                    msg.content,
                    this._log,
                    { ...fetchOptions, messageId: msg.id },
                  );
                droppedMedia = dropped;
                if (blocks.length > 0) {
                  userMessage = blocks;
                } else {
                  const textFallback = flattenContentToText(msg.content);
                  if (textFallback) {
                    userMessage = textFallback;
                    this._log.warn(
                      `${LOG_PREFIX} all media content blocks failed conversion; falling back to text`,
                    );
                  } else {
                    // Report what was lost BEFORE refusing: this is the one
                    // case where the per-item reasons matter most, and
                    // returning first meant the client only ever saw the
                    // refusal with no account of why.
                    yield* this._reportDroppedMedia(dropped, 0);
                    yield _runError(
                      "All media content blocks failed conversion and no text fallback is available",
                      "MEDIA_RESOLUTION_FAILED",
                    );
                    return;
                  }
                }
              } else {
                userMessage = flattenContentToText(msg.content);
              }
            } else {
              userMessage = msg.content as string;
            }
            break;
          }
        }
      }

      // Allow configuration to enrich the outgoing user message. Multimodal
      // prompts pass through unchanged so binary payloads reach the model
      // intact.
      if (this.config.stateContextBuilder) {
        try {
          const textForBuilder = Array.isArray(userMessage)
            ? flattenContentToText(userMessage)
            : userMessage;
          const builderResult = this.config.stateContextBuilder(
            inputData,
            textForBuilder,
            buildContextExtras(inputData),
          );
          if (!Array.isArray(userMessage)) {
            userMessage = builderResult;
          }
        } catch (e) {
          this._log.error(`${LOG_PREFIX} stateContextBuilder failed:`, e);
          yield {
            type: EventType.CUSTOM,
            name: "hook_error",
            value: {
              hook: "stateContextBuilder",
              tool: "__prompt__",
              error: _errorMessage(e),
            },
          };
        }
      }

      // Attachments that never reached the model are reported before it runs,
      // so a client sees the loss alongside the turn it belongs to rather than
      // having to infer it from an answer that ignores the attachment.
      yield* this._reportDroppedMedia(
        droppedMedia,
        Array.isArray(userMessage)
          ? // Media blocks only: the text blocks alongside them are not what a
            // client is asking about when it asks what arrived.
            userMessage.filter((b) => !(b instanceof TextBlock)).length
          : 0,
      );

      // Per-run state.
      let messageId = uuid();
      let messageStarted = false;
      let accumulatedText = "";
      // Citations belong to the message that was open when they arrived, so
      // this is drained at every message boundary. It counts its own text
      // offset rather than reading `accumulatedText`, which is reset only when
      // message snapshots are being emitted.
      const citations = new CitationAccumulator(this._log);
      const toolCallsSeen = new Map<string, SeenToolCall>();
      // Tracks state for the final snapshot. Seeded from a plain object only:
      // the tool-driven updates below are key/value merges, and a client is
      // free to send a state that is not one, which a spread takes apart into
      // index keys rather than leaving alone.
      const currentState: Record<string, unknown> = _isPlainStateObject(
        inputData.state,
      )
        ? { ...(inputData.state as Record<string, unknown>) }
        : {};
      let stopModelStreaming = false;
      let haltEventStream = false;
      let pendingHalt = false;
      // Set when the halt came from a frontend tool call, which is the one halt
      // that must complete through Strands rather than cancel it.
      let frontendHalt = false;
      // Arm the frontend-tool halt. The wire is not muted here: the rest of the
      // tool batch still has results to deliver, and the mute waits for
      // `afterToolsEvent`. The model's own output is the exception, text and
      // reasoning alike, because the run ends with this batch and both belong to
      // a turn the client will never see completed.
      // (`stopStreamingAfterResult` sets the same flag but mutes the whole wire
      // at once.)
      const armFrontendHalt = (): void => {
        pendingHalt = true;
        stopModelStreaming = true;
      };

      let reasoningStarted = false;
      let reasoningMessageId: string | undefined;

      // Tool currently being streamed via toolUseInputDelta events. Populated
      // by modelContentBlockStartEvent or toolUseInputDelta, flushed on
      // modelContentBlockStopEvent.
      let currentToolUse: {
        name: string;
        /** Exactly what Strands supplied, so the identity guards can see none. */
        nativeToolUseId: string | undefined;
        /** Backend fallback, minted once so both delta and stop agree on it. */
        toolUseId: string;
        inputChunks: string[];
      } | null = null;

      // Reconcile Strands' internal conversation history with
      // ``RunAgentInput.messages`` when no ``sessionManager`` is wired.
      // Without this, frontend tool results never reach the LLM — Strands
      // sees an open ``toolUse`` from the prior turn and the LLM re-fires
      // the same tool every run.
      const replayHistory =
        this.config.replayHistoryIntoStrands !== false &&
        !(strandsAgent as { sessionManager?: unknown }).sessionManager;
      let invokeArgs:
        | string
        | ContentBlock[]
        | InterruptResponseContent[]
        | undefined = userMessage;

      // Resume path: convert AG-UI `resume[]` into Strands
      // `InterruptResponseContent[]`. The `run()` gate has already
      // filtered unknown IDs by this point.
      const resumeEntries = resolveResumeEntries(inputData);
      if (resumeEntries.length > 0) {
        // Rule 8 suppression, from the same resolved set the view was built
        // from rather than a second walk of the pending interrupts.
        for (const toolCallId of resumeBoundResultIds) {
          pendingToolResultIds.add(toolCallId);
        }
        // A cancelled tool-bound interrupt gets no synthetic result here.
        // The denial is forwarded to Strands below, its approval hook sets
        // `cancel`, and the SDK produces the error tool result the
        // afterToolCallEvent branch already turns into TOOL_CALL_RESULT.
        // Emitting one here too gave the same toolCallId two results.
        //
        // Note: even when ALL entries are cancelled, we still forward the
        // denial responses to Strands via stream() below rather than
        // short-circuiting here. This ensures native interrupt-state
        // cleanup, hooks, snapshots, and session persistence all run
        // through Strands' normal completion path instead of being
        // bypassed by a synthetic RUN_FINISHED.

        // A tool approval is answered raw and everything else with the
        // envelope, so the checkpoint decides the shape. Read it through the
        // same helper as the replay comparison, which keeps what is submitted
        // and what a replay is checked against from ever disagreeing.
        const nativeInterrupts = _nativeInterruptsById(
          (
            strandsAgent as unknown as {
              _interruptState?: { interrupts?: unknown };
            }
          )._interruptState?.interrupts,
        );
        invokeArgs = resumeEntries.map(
          (entry) =>
            new InterruptResponseContent({
              interruptId: entry.interruptId,
              response: toResumeResponse(
                entry,
                nativeInterrupts.get(entry.interruptId),
              ) as JSONValue,
            }),
        );
      }
      // Exact proxy placeholders parked by an activated checkpoint. Correcting
      // one needs the same session-manager boundary a safe resume needs, and
      // the check for that sits after the stream rather than here: it runs
      // before the interrupt is ever advertised, so a checkpoint that cannot be
      // rewritten never reaches a client and no later run can arrive carrying
      // one.
      const activeProxyNativeIds = activeProxyPlaceholderIds(strandsAgent);
      // Parked stubs the exact rewrite would decline: one carrying a block this
      // adapter did not write, or a field the proxy never wrote. Reported
      // permissively for the same reason the message path reports them, and
      // acted on separately below, because no mapped client result makes one
      // correctable.
      const uncorrectableProxyNativeIds =
        uncorrectableProxyPlaceholderIds(strandsAgent);

      // Scope: this continuation's just-returned results, plus any earlier
      // frontend call whose placeholder is still uncorrected.
      //
      // The trailing run of results is not the whole of it: it misses a result
      // the client delivers with a user message after it, and a result that
      // never reaches reconciliation leaves the persisted placeholder forever.
      // Either provenance signal brings such a result back into scope, and both
      // are safe: a recorded id is dropped once its placeholder is corrected,
      // and the stub the other signal reads IS that placeholder, so an
      // already-reconciled result cannot re-enter on either one.
      const frontendResults = turnToolCalls.clientAnswers;
      const hasNewerUserMessage = turnToolCalls.hasNewerUserMessage;

      // Reconcile only results whose call this adapter emitted: a persisted
      // placeholder exists for those alone, and correcting anything else would
      // be guesswork.
      const resolvedNativeResults = new Map<string, PendingFrontendResult>();
      const resumeSubmitted = resumeEntries.length > 0;
      if (reconciliationSetupError === undefined && sessionManager) {
        for (const answer of frontendResults) {
          if (!answer.admitted) continue;
          resolvedNativeResults.set(answer.toolCallId!, answer.result);
        }
      }

      if (reconciliationSetupError !== undefined) {
        if (_hasActiveInterrupt(strandsAgent)) {
          this._log.error(
            `${LOG_PREFIX} Active interrupt tool result reconciliation failed`,
            reconciliationSetupError,
          );
          yield _interruptReconciliationError();
          return;
        }
        this._log.warn(
          `${LOG_PREFIX} Frontend tool result reconciliation failed; falling back ` +
            `to the legacy continuation path: ${_errorMessage(reconciliationSetupError)}`,
        );
      }

      // Resuming clears the parked context into the history the model reads, so
      // a stub the rewrite cannot correct has nowhere left to go: this path has
      // no continuation prompt to carry the client's answer, which is what the
      // message path falls back to. It fails closed before any store or live
      // checkpoint mutation begins, so the client can retry against an untouched
      // checkpoint. Demanding a mapped result would not help: the rewrite is
      // exact, so it declines these however many results the turn carries.
      if (resumeSubmitted && uncorrectableProxyNativeIds.size > 0) {
        this._log.error(
          `${LOG_PREFIX} Active interrupt parks proxy placeholders no rewrite can ` +
            `correct, so the resume would feed them to the model: native ids ` +
            `${JSON.stringify([...uncorrectableProxyNativeIds].sort())}`,
        );
        yield _interruptReconciliationError();
        return;
      }

      // Every exact proxy placeholder in that context needs a mapped client
      // result, under the same "before the first write" rule. Together with the
      // gate above this is all that path needs: a parked id is reported as
      // exact only when its result is the exact placeholder, so once a client
      // result is mapped to it the correction below cannot fail to apply, and a
      // correction that throws is caught there.
      if (resumeSubmitted && activeProxyNativeIds.size > 0) {
        const missing = [...activeProxyNativeIds].filter(
          (id) => !resolvedNativeResults.has(id),
        );
        if (missing.length > 0) {
          this._log.error(
            `${LOG_PREFIX} Active interrupt is missing mapped frontend results for ` +
              `native ids ${missing.sort().join(", ")}`,
          );
          yield _interruptReconciliationError();
          return;
        }
      }

      // The history the replay path would install, built before the decision
      // because whether it has anything in it is one of the decision's inputs:
      // an empty replay falls through to the prompt, and the prompt is what an
      // unnameable result is fatal for. Building it writes nothing.
      const nativeHistory =
        replayHistory && !resumeSubmitted
          ? await _buildStrandsHistory(
              inputData.messages ?? [],
              turnToolCalls,
              this._log,
              fetchOptions,
            )
          : [];

      // A replay that DROPS one of this turn's client answers is the re-fire
      // loop, not a continuation. The orphan-result guard discards the answer
      // whose call the request never carried, the history that then REPLACES
      // Strands' own holds the question alone, and `stream(undefined)` throws
      // away the prompt that could still have said what came back, so the model
      // fires the same tool again. The single view is what makes that visible
      // here: the absent assistant block that puts an answer out of the replay's
      // reach is the same absence the name lookup goes to the STORE to work
      // around.
      const replayCarriesEveryAnswer =
        turnToolCalls.unreplayableAnswerIds.length === 0;
      if (nativeHistory.length > 0 && !replayCarriesEveryAnswer) {
        this._log.warn(
          `${LOG_PREFIX} history replay cannot carry the client's answer for ` +
            `toolCallIds=${turnToolCalls.unreplayableAnswerIds.join(", ")}; ` +
            "continuing from the prompt so the answer reaches the model",
        );
      }

      // A client answer the carry below has to SAY needs its tool's name exactly
      // as a trailing one does, and a user message after the result puts it out
      // of the trailing derivation's reach. So it joins the same fail-closed
      // report, under the same code, rather than being dropped from a prompt
      // that cannot phrase it. Read per answer, because taking it from the LAST
      // one silences the report for every older answer the same payload carries.
      const unnameableAnswerIds = frontendResults
        .filter((answer) => !answer.name)
        .map((answer) => answer.toolCallId!);

      // The whole decision, in one place and before the first write, so a turn
      // that cannot be fully repaired persists nothing and takes the fallback
      // path cleanly.
      //
      // A native-only live checkpoint needs no store access. Exact proxy
      // placeholders do, including when the client result is void.
      //
      // `replayHistoryIntoStrands` reaches `canReconcile` not at all: it governs
      // the replay arm, which runs only when no session manager is wired. Under
      // one, the placeholder is this adapter's own persisted write and no caller
      // can correct it in the adapter's place, so an opt-out would leave the
      // store asserting "Forwarded to client" as the client's answer forever.
      // The Python adapter reads the flag on one arm of a disjunction whose
      // other arm, a resume with parked placeholders, bypasses it; here the arms
      // are the plan's branches instead.
      const plan = planContinuation({
        unnameableResultIds: [
          ...new Set([...unnameableResultIds, ...unnameableAnswerIds]),
        ],
        canReplayHistory: nativeHistory.length > 0 && replayCarriesEveryAnswer,
        setupFailed: reconciliationSetupError !== undefined,
        canReconcile: supportsSnapshotReconciliation(
          sessionManager,
          strandsAgent,
          this._log,
        ),
        frontendResults: frontendResults.map((answer) => ({
          toolCallId: answer.toolCallId!,
          text: answer.result.text,
          isError: answer.result.isError,
        })),
        admittedIds: new Set(resolvedNativeResults.keys()),
        parkedPlaceholderCount: activeProxyNativeIds.size,
        resumeSubmitted,
      });

      // Client answers the native history does not carry, so the prompt has to.
      // Filled in by whichever branch below settles it.
      let uncarriedResults: readonly string[] = [];

      // Nothing named the tool behind a trailing result, and the run has to say
      // what came back. Raised here, before reconciliation persists or prunes
      // anything, so the retry still has the admission signal it needs.
      if (plan.kind === "fail-unnameable") {
        yield _continuationToolNameError(plan.toolCallIds);
        return;
      }

      if (plan.kind === "replay-history") {
        // Apply stateContextBuilder to the last user-text message in the
        // reconciled history rather than to the synthetic `userMessage`
        // string, which is what the LLM actually sees.
        if (this.config.stateContextBuilder) {
          for (let i = nativeHistory.length - 1; i >= 0; i--) {
            const m = nativeHistory[i];
            if (!m || m.role !== "user") continue;
            const first = (m.content as Array<{ text?: string }>)[0];
            if (first && typeof first.text === "string") {
              try {
                const augmented = this.config.stateContextBuilder(
                  inputData,
                  first.text,
                  buildContextExtras(inputData),
                );
                if (typeof augmented === "string") first.text = augmented;
              } catch (e) {
                this._log.error(`${LOG_PREFIX} stateContextBuilder failed:`, e);
                yield {
                  type: EventType.CUSTOM,
                  name: "hook_error",
                  value: {
                    hook: "stateContextBuilder",
                    tool: "__prompt__",
                    error: _errorMessage(e),
                  },
                };
              }
              break;
            }
          }
        }
        // Convert plain-object history into real Message instances: Bedrock's
        // request formatter dispatches on `block.type`, which only the class
        // instances carry.
        (strandsAgent as { messages: unknown[] }).messages = nativeHistory.map(
          (m) =>
            StrandsMessage.fromMessageData({
              role: m.role,
              content: m.content as never,
            }),
        );
        // `stream(undefined)` tells Strands to use `this.messages` as-is.
        invokeArgs = undefined;
      } else if (plan.kind === "reconcile") {
        let correctedIds: ReadonlySet<string> = new Set<string>();
        try {
          correctedIds = await reconcileFrontendToolResults(
            sessionManager!,
            strandsAgent,
            resolvedNativeResults,
          );
        } catch (e) {
          if (_hasActiveInterrupt(strandsAgent)) {
            this._log.error(
              `${LOG_PREFIX} Active interrupt tool result reconciliation failed`,
              e,
            );
            yield _interruptReconciliationError();
            return;
          }
          // Truthful because the reconciler leaves nothing of a failed attempt
          // behind: the history still holds the stub, the call id is still
          // recorded, and the prompt below is what carries the client's answer.
          this._log.warn(
            `${LOG_PREFIX} Frontend tool result reconciliation failed; falling back ` +
              `to the legacy continuation path: ${_errorMessage(e)}`,
          );
        }
        // Continue from the corrected native history only when every admitted
        // result this turn carries actually ended up corrected. Admission was
        // settled by the decision above, but a correction can still decline: a
        // stub carrying content this adapter did not write is never overwritten.
        //
        // Read from what the reconciler REPORTS it corrected, across both the
        // surfaces it writes to. Deriving it from the ABSENCE of a stub instead
        // calls an answer corrected whenever its block is simply gone, which the
        // SDK's default sliding message window makes routine, and cannot see a
        // parked correction decline at all because those results live outside
        // `agent.messages`.
        //
        // An empty admitted set means nothing was admitted, so nothing can have
        // been corrected: that answers "a stub remains", not "the history is
        // clean".
        const declinedIds = [...resolvedNativeResults.keys()]
          .filter((id) => !correctedIds.has(id))
          .sort();
        const reconciled =
          resolvedNativeResults.size > 0 && declinedIds.length === 0;
        if (declinedIds.length > 0) {
          // Said out loud. A decline leaves the client's answer where only the
          // fallback below can reach the model with it, and both of the ways
          // that fallback can fail are silent otherwise.
          this._log.warn(
            `${LOG_PREFIX} Frontend tool result reconciliation corrected nothing ` +
              `for native ids ${declinedIds.join(", ")}; the client's answer has ` +
              `to reach the model through the continuation prompt instead`,
          );
        }
        if (resumeSubmitted) {
          // The resume path already put its `InterruptResponseContent[]` on
          // `invokeArgs` and must keep it: a resume batch can still carry a fresh
          // frontend tool result that needed reconciling. That is also why it has
          // no continuation prompt to fall back on, so a decline here leaves the
          // uncorrected stub as what the model reads for the client's answer.
          // Refused, like the pre-write gates above, rather than answered with a
          // stub. Later than those gates by necessity: only the attempt itself
          // says a correction declined.
          if (declinedIds.length > 0) {
            this._log.error(
              `${LOG_PREFIX} Active interrupt tool result reconciliation failed: ` +
                `no correction landed for native ids ${declinedIds.join(", ")}`,
            );
            yield _interruptReconciliationError();
            return;
          }
        } else {
          // A PARTIAL decline still sends the prompt, and the prompt phrases
          // every trailing result of the turn -- including the ones this call
          // just wrote into the history. So the lines whose answer landed come
          // back out, and what goes out is only what the history does not say.
          // A decline is only knowable after a write, so this is the
          // all-or-nothing rule of the decision above, held on the far side.
          //
          // With every trailing line corrected there is nothing left for the
          // prompt to say, so the history speaks for itself and the carry below
          // is free to prepend the non-trailing answers that declined.
          const kept = trailingPromptLines.filter(
            ({ toolCallId }) => !toolCallId || !correctedIds.has(toolCallId),
          );
          const prompt =
            kept.length === trailingPromptLines.length
              ? userMessage
              : kept.length > 0
                ? kept.map(({ line }) => line).join("\n")
                : undefined;
          invokeArgs = reconciled && !hasNewerUserMessage ? undefined : prompt;
          uncarriedResults = declinedIds;
        }
      } else if (plan.kind === "prompt") {
        // Nothing was repaired, so no answer is in the history.
        uncarriedResults = frontendResults.map((answer) => answer.toolCallId!);
      }

      // Client answers no correction landed for that the trailing derivation
      // above never phrased either, so they reach the model through neither the
      // history nor the prompt. A user message after an answer puts it out of
      // that derivation's reach, and it can be an EARLIER answer of the same
      // payload, which is why this reads each answer's own place in the request
      // rather than one flag taken from the last of them. Carried ahead of
      // whatever prompt the run is sending rather than dropped, because dropping
      // leaves the model to re-fire the call it is already being answered about.
      //
      // Bounded by `alreadyPrompted`. A placeholder no correction can EVER
      // repair (a stub some hook decorated, which detection reports and the
      // exact rewrite refuses) declines on every turn while both provenance
      // signals stay alive, since a recorded id is only retired by a correction
      // that lands; carrying it again each turn repeats the same stale answer
      // without bound. So the carry retires an answer on the only thing that
      // means the model has it, the history already saying it. Reconciliation
      // never retires it, which would strand a stub a later turn could repair.
      if (!resumeSubmitted && uncarriedResults.length > 0) {
        const carried = new Set(uncarriedResults);
        const lines: string[] = [];
        for (const answer of frontendResults) {
          if (answer.trailing) continue;
          if (!carried.has(answer.toolCallId!)) continue;
          if (answer.alreadyPrompted) {
            this._log.debug(
              `${LOG_PREFIX} Not restating a client answer the history already ` +
                `carries in words: toolCallId=${answer.toolCallId}`,
            );
            continue;
          }
          // Always resolves: an unnameable carried answer failed the run above.
          if (answer.name) {
            lines.push(_continuationResultLine(answer.name, answer.result));
          }
        }
        if (lines.length > 0) {
          const preamble = lines.join("\n");
          invokeArgs =
            typeof invokeArgs === "string"
              ? `${preamble}\n${invokeArgs}`
              : [
                  new TextBlock(preamble),
                  ...((invokeArgs ?? []) as ContentBlock[]),
                ];
        }
      }

      // Replay disabled, cold agent, continuation run: the seed already ends
      // with the user-role toolResult turn, so handing the synthetic
      // continuation prompt to `stream()` would have Strands append a SECOND
      // user message. The provider-bound roles become user -> assistant ->
      // user -> user, which Bedrock refuses for failing role alternation.
      // Folding the prompt into the turn that is already there keeps the
      // continuation as one user turn carrying both the toolResult block and
      // the prompt. Only reached on the opt-out; the documented default
      // returns above with `invokeArgs = undefined`.
      if (
        !replayHistory &&
        !resumeSubmitted &&
        typeof invokeArgs === "string"
      ) {
        const seeded = (strandsAgent as { messages?: unknown[] }).messages;
        const tail = seeded?.[seeded.length - 1] as
          | { role?: string; content?: unknown[] }
          | undefined;
        const tailCarriesToolResult =
          tail?.role === "user" &&
          Array.isArray(tail.content) &&
          tail.content.some((b) => {
            // Seeded history arrives as ContentBlock INSTANCES, which carry a
            // `type` discriminant; the plain-object form carries the key
            // itself. Both shapes reach here depending on the path.
            const block = b as { toolResult?: unknown; type?: string };
            return (
              block?.toolResult !== undefined ||
              block?.type === "toolResultBlock"
            );
          });
        if (tailCarriesToolResult) {
          // Rebuilt from the serialized form so the appended text block is a
          // real instance like the ones already there; Bedrock's formatter
          // dispatches on `block.type`, which only instances carry.
          const tailData = (
            tail as unknown as { toJSON?: () => { content?: unknown[] } }
          ).toJSON?.() ?? { content: tail!.content };
          (strandsAgent as { messages: unknown[] }).messages = [
            ...seeded!.slice(0, -1),
            StrandsMessage.fromMessageData({
              role: "user",
              content: [
                ...((tailData.content ?? []) as never[]),
                { text: invokeArgs } as never,
              ] as never,
            }),
          ];
          invokeArgs = undefined;
        }
      }

      // Native ids already in this thread's history, captured after any history
      // replacement above and before the stream appends this run's own calls.
      // A frontend call landing on one of these cannot be told apart from the
      // earlier call that owns the persisted placeholder.
      const priorToolCallIds = _nativeAssistantToolCallIds(strandsAgent);

      this._log.debug(
        `${LOG_PREFIX} Starting agent run: threadId=${inputData.threadId}, runId=${inputData.runId}, ` +
          `pendingToolResultIds=${JSON.stringify([...pendingToolResultIds])}, ` +
          `messageCount=${inputData.messages?.length ?? 0}`,
      );

      // The resume is spent here rather than where its payload was built,
      // after the last gate that can still end the run with a RUN_ERROR, so a
      // run refused by one of those gates leaves the record it never acted on
      // exactly as it found it.
      if (resumeEntries.length > 0) {
        this._pendingInterruptsByThread.delete(threadId);
        persistInterruptBookkeeping(strandsAgent, null, null, this._log);
      }

      // The application's context, rendered once for the model. It is shown
      // from a before-model-call hook and withdrawn from the paired after-hook
      // (see `model-context.ts`), so it needs a hook registry to ride on. A
      // real `Agent` always has one; an agent that does not cannot honour a
      // non-empty block, and pretending otherwise would silently drop what
      // the app asked the model to know. Python raises the same way at the
      // same point, after RUN_STARTED, so the client sees a RUN_ERROR.
      const contextBlock = formatAguiContext(modelContext);
      if (contextBlock && !ensureTransientContextHook(strandsAgent)) {
        throw new Error(
          "Strands agent does not expose a hook registry for transient context",
        );
      }

      // AbortController wired into Strands's `cancelSignal` so that abandoning
      // the outer generator (HTTP client disconnect) stops the underlying
      // Bedrock streaming call rather than silently burning tokens.
      const agentStream = strandsAgent.stream(invokeArgs as never, {
        cancelSignal: runAbort.signal,
      });
      // `agent.stream()` returns the final `AgentResult` on `{ done: true }`.
      // Captured here so the interrupt-variant RUN_FINISHED below can pull
      // `stopReason` and `interrupts[]` off it.
      let finalAgentResult: StrandsAgentResult | undefined;
      // The shared terminal-failure report. The TS SDK has no ForceStopEvent,
      // so the throw that Python's generic `except Exception` would have
      // reported through one is the signal here. Recorded rather than
      // rethrown so the stream teardown and the message/tool-call closeout
      // below still run, as they do in Python after its `force_stop` event.
      // The failures `record` rethrows instead are the ones Python also leaves
      // to its outer handler, and they skip that closeout on both bridges.
      const forcedStop = new ForcedStop(this._log, "Agent stream", threadId);

      try {
        while (true) {
          let next: IteratorResult<AgentStreamEvent, unknown>;
          try {
            // The one pull site, so the one place the request's context block
            // is in scope for the SDK. Python scopes its ContextVar around
            // each `__anext__` for the same reason.
            next = await pullWithModelContext(agentStream, contextBlock);
          } catch (streamErr) {
            // Strands throws "Stream ended without completing a message" when
            // a frontend tool call halts the agent before the model emits a
            // final assistant message. Once we have decided to halt, that
            // throw is expected flow and the run finishes. A genuine provider
            // failure in the same window is not, and must not be swallowed
            // into a success.
            //
            // `frontendHalt` deliberately stays as it is, so the halt-turn
            // closeout below is skipped rather than reached with nothing to do.
            // Strands defers
            // appending BOTH the assistant `toolUse` and its `toolResult` until
            // after the tool batch, and yields them only after the
            // `afterToolsEvent` the latch rides, so a throw arriving here landed
            // before either message existed: there is no stamped halt turn to
            // trim and no placeholder to persist. What this run did record (the
            // call id it handed the client, and any earlier cycle's messages) is
            // already in the store, because `Agent.stream()` drains `_stream` in
            // its own `finally` on the error path and the `AfterInvocationEvent`
            // that comes out of the drain saves the snapshot before the throw
            // reaches this loop. Saving again here would write the same bytes.
            //
            // A `TypeError` or `ReferenceError` is never that throw, so it is
            // held out of the swallow: the sentinel is identified by shape
            // rather than by type, and `stop-reasons.test.ts` drives one of
            // these wearing that shape. Held out of the SWALLOW only. What it
            // reports is not decided here: like every other failure out of
            // this call it is recorded as the forced stop, so the message and
            // tool-call closeout still runs, which is what Python does with an
            // exception Strands caught mid-cycle whatever its type.
            const cannotBeHaltSentinel =
              streamErr instanceof TypeError ||
              streamErr instanceof ReferenceError;
            if (
              !cannotBeHaltSentinel &&
              (pendingHalt || haltEventStream) &&
              _isFrontendHaltSentinel(streamErr)
            ) {
              haltEventStream = true;
              break;
            }
            forcedStop.record(streamErr);
            break;
          }
          if (next.done) {
            finalAgentResult = next.value as StrandsAgentResult | undefined;
            break;
          }
          // Strands v1 wraps raw model events inside `ModelStreamUpdateEvent`
          // (type: 'modelStreamUpdateEvent', event: ModelStreamEvent) before
          // yielding them from `agent.stream()`. Unwrap once so the dispatch
          // below operates on the inner event shape.
          // `contentBlockEvent` is the assembled form of deltas that have
          // already streamed, so it must never reach the RAW fallback (see
          // `isAssembledContentBlock`). The wrapper kind has to be captured
          // BEFORE unwrapping, because unwrapping is exactly what erases it —
          // the bare block's own `type` is `textBlock` / `reasoningBlock` /
          // whatever the SDK adds next.
          const isAssembledBlock = isAssembledContentBlock(next.value);
          const event = unwrapStrandsEvent(next.value);
          const kind = getEventKind(event);

          // End of the tool batch, and so the frontend halt's latch point: it
          // arrives once every tool in the batch has produced its result, so a
          // backend sibling of the frontend call still reaches the wire below.
          // Answering `endTurn` rather than cancelling is what stops the loop
          // before another model cycle while still letting Strands append BOTH
          // the assistant `toolUse` and the placeholder `toolResult` a later
          // run has to reconcile.
          //
          // Checked ABOVE the mute below, not after it: another halt in the same
          // batch (a `stopStreamingAfterResult` tool) mutes the wire first, and
          // latching after that would skip the endTurn stamp, so the turn would
          // persist neither the call nor its placeholder and no continuation
          // could repair what the client is already answering.
          if (kind === "afterToolsEvent" && pendingHalt && !frontendHalt) {
            (event as { endTurn: boolean | string }).endTurn =
              FRONTEND_HALT_TURN_TEXT;
            frontendHalt = true;
            haltEventStream = true;
            continue;
          }

          if (haltEventStream) continue;

          // --- Delta events (text, reasoning, tool-use input streaming) ---
          // Maps to Python's top-level "data" / "reasoningText" /
          // "current_tool_use" branches.
          if (kind === "modelContentBlockDeltaEvent") {
            const delta = (
              event as unknown as {
                delta:
                  | { type: "textDelta"; text: string }
                  | {
                      type: "reasoningContentDelta";
                      text?: string;
                      redactedContent?: Uint8Array;
                    }
                  | { type: "toolUseInputDelta"; input: string };
              }
            ).delta;

            // Text data chunks.
            if (delta.type === "textDelta" && delta.text) {
              if (stopModelStreaming) continue;
              if (!messageStarted) {
                yield {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId,
                  role: "assistant",
                };
                messageStarted = true;
              }
              accumulatedText += delta.text;
              citations.advance(delta.text);
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: delta.text,
                // Citations reach the client on the next text delta after they
                // arrive, so a reader sees its sources while the answer is
                // still streaming rather than only once the message closes.
                ...citationMetadata(citations.pending()),
              };
              continue;
            }

            // A citation, held until the message it annotates publishes it. It
            // is recorded against the text emitted so far, which is the only
            // positional information available: the citation itself locates a
            // span in the SOURCE document and says nothing about where in the
            // answer it belongs.
            //
            // Consuming it here is also what stops citations being forwarded as
            // RAW. That fallback is for events this adapter does not map, and
            // this one is now mapped.
            if (citations.add(delta)) continue;

            // Reasoning/thinking text streaming. Muted by the same flag as
            // text: reasoning the model produces after the halt is armed
            // belongs to the same turn the client will never see completed.
            if (delta.type === "reasoningContentDelta") {
              if (stopModelStreaming) continue;
              if (delta.text) {
                if (!reasoningStarted) {
                  reasoningMessageId = uuid();
                  yield {
                    type: EventType.REASONING_START,
                    messageId: reasoningMessageId,
                  };
                  yield {
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: reasoningMessageId,
                    role: "reasoning",
                  };
                  reasoningStarted = true;
                }
                yield {
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageId!,
                  delta: delta.text,
                };
              } else if (delta.redactedContent) {
                if (!reasoningStarted) {
                  reasoningMessageId = uuid();
                  yield {
                    type: EventType.REASONING_START,
                    messageId: reasoningMessageId,
                  };
                  yield {
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: reasoningMessageId,
                    role: "reasoning",
                  };
                  reasoningStarted = true;
                }
                yield {
                  type: EventType.REASONING_ENCRYPTED_VALUE,
                  subtype: "message",
                  entityId: reasoningMessageId!,
                  encryptedValue: Buffer.from(delta.redactedContent).toString(
                    "base64",
                  ),
                };
              }
              continue;
            }

            // Tool call input streaming — emits PredictState → TOOL_CALL_START
            // → incremental TOOL_CALL_ARGS deltas. Tools declaring an
            // argsStreamer take the legacy burst-at-contentBlockStop path.
            if (delta.type === "toolUseInputDelta" && currentToolUse) {
              currentToolUse.inputChunks.push(delta.input);
              const {
                name: toolName,
                nativeToolUseId,
                toolUseId: strandsToolId,
              } = currentToolUse;
              const isFrontendTool = frontendToolNames.has(toolName);
              const toolUseId = _resolveToolUseId({
                seen: toolCallsSeen,
                toolName,
                nativeToolUseId,
                fallbackToolUseId: strandsToolId,
                isFrontendTool,
                priorToolCallIds,
                onNewFrontendCall: recordFrontendCall,
              });

              let entry = toolCallsSeen.get(toolUseId);
              if (!entry) {
                const isPendingNow = pendingToolResultIds.has(toolUseId);
                const behaviorNow = this.config.toolBehaviors?.[toolName];
                this._log.debug(
                  `${LOG_PREFIX} Tool call event received: toolName=${toolName}, ` +
                    `toolUseId=${toolUseId}, strandsId=${strandsToolId}, ` +
                    `isFrontend=${isFrontendTool}, threadId=${inputData.threadId}`,
                );
                // Use streaming (emit ToolCallStart + PredictState now,
                // ToolCallArgs on each growth, ToolCallEnd at
                // contentBlockStop) unless the tool is a continuation or
                // supplies a custom argsStreamer.
                const useStreaming =
                  !isPendingNow && !behaviorNow?.argsStreamer;
                entry = {
                  name: toolName,
                  args: "",
                  input: {},
                  raw: "",
                  emitted: false,
                  startEmitted: false,
                  endEmitted: false,
                  lastEmittedRawLen: 0,
                  isPending: isPendingNow,
                  isFrontend: isFrontendTool,
                  useStreaming,
                  strandsToolId,
                };
                toolCallsSeen.set(toolUseId, entry);

                if (useStreaming) {
                  // Close any open assistant text turn so the snapshot order
                  // matches the wire-event order and message_id can rotate.
                  if (!messageStarted) {
                    discardOrphanCitations(
                      citations,
                      `threadId=${inputData.threadId}`,
                      this._log,
                    );
                  }
                  if (messageStarted) {
                    const closingCitations = citations.take();
                    yield {
                      type: EventType.TEXT_MESSAGE_END,
                      messageId,
                      ...citationMetadata(closingCitations),
                    };
                    if (emitMessagesSnapshot && accumulatedText) {
                      snapshotMessages.push({
                        id: messageId,
                        role: "assistant",
                        content: accumulatedText,
                        ...citationMetadata(
                          copyCitationMetadata(closingCitations, this._log),
                        ),
                      } as AguiAssistantMessage);
                      accumulatedText = "";
                      yield {
                        type: EventType.MESSAGES_SNAPSHOT,
                        messages: snapshotMessages.slice(),
                      };
                    }
                    messageStarted = false;
                    messageId = uuid();
                  }

                  // PredictState must reach the FE BEFORE any args delta so
                  // the FE knows which tool argument feeds which state key
                  // while parsing incremental JSON.
                  if (behaviorNow) {
                    const predict = normalizePredictState(
                      behaviorNow.predictState,
                    ).map(predictStateMappingToPayload);
                    if (predict.length > 0) {
                      yield {
                        type: EventType.CUSTOM,
                        name: "PredictState",
                        value: predict,
                      };
                    }
                  }

                  yield {
                    type: EventType.TOOL_CALL_START,
                    toolCallId: toolUseId,
                    toolCallName: toolName,
                    parentMessageId: messageId,
                  };
                  entry.startEmitted = true;
                }
              }

              // Rebuild the accumulated raw string and emit the growth as a
              // single TOOL_CALL_ARGS delta. The FE concatenates these into
              // the full args payload and parses incrementally.
              const rawStr = currentToolUse.inputChunks.join("");
              entry.raw = rawStr;
              try {
                entry.input = JSON.parse(rawStr);
              } catch {
                entry.input = rawStr;
              }
              entry.args =
                typeof entry.input === "string"
                  ? entry.input
                  : JSON.stringify(entry.input);

              if (entry.startEmitted && entry.useStreaming) {
                const lastLen = entry.lastEmittedRawLen ?? 0;
                if (rawStr.length > lastLen) {
                  yield {
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId: toolUseId,
                    delta: rawStr.slice(lastLen),
                  };
                  entry.lastEmittedRawLen = rawStr.length;
                }
              }
            }

            // Only the delta kinds handled above are consumed here. Anything
            // else falls through to the RAW fallback: Bedrock citations reach
            // the adapter as `citationsDelta` inside this event, so an
            // unconditional continue is what kept them off the wire.
            const handled: ReadonlyArray<string> = [
              "textDelta",
              "reasoningContentDelta",
              "toolUseInputDelta",
            ];
            if (handled.includes((delta as { type: string }).type)) {
              continue;
            }
          }

          // Reasoning signature (verification token) — not exposed to UI.
          if (kind === "reasoningSignatureEvent") continue;

          // Content block start records tool metadata so toolUseInputDelta
          // can correlate its chunks to a tool. Strands v1 emits
          // `{ start: { type: "toolUseStart", name, toolUseId } }` — the
          // field is `.start`, not `.contentBlock`.
          if (kind === "modelContentBlockStartEvent") {
            const startWrap = event as unknown as {
              start?: { type?: string; name?: string; toolUseId?: string };
            };
            const s = startWrap.start;
            if (s?.type === "toolUseStart" && s.name) {
              currentToolUse = {
                name: s.name,
                nativeToolUseId: s.toolUseId,
                toolUseId: s.toolUseId ?? uuid(),
                inputChunks: [],
              };
            }
            continue;
          }

          // Content block stop — signals tool input is complete.
          if (kind === "modelContentBlockStopEvent") {
            if (reasoningStarted) {
              yield {
                type: EventType.REASONING_MESSAGE_END,
                messageId: reasoningMessageId!,
              };
              yield {
                type: EventType.REASONING_END,
                messageId: reasoningMessageId!,
              };
              reasoningStarted = false;
              reasoningMessageId = undefined;
            }

            if (currentToolUse) {
              const {
                name: toolName,
                nativeToolUseId,
                toolUseId: strandsToolId,
                inputChunks,
              } = currentToolUse;
              currentToolUse = null;
              const rawInput = inputChunks.join("");
              let parsedInput: unknown = {};
              if (rawInput) {
                try {
                  parsedInput = JSON.parse(rawInput);
                } catch (e) {
                  this._log.warn(
                    `${LOG_PREFIX} tool args JSON parse failed for ${toolName}; using raw string`,
                    e,
                  );
                  parsedInput = rawInput;
                }
              }
              const isFrontendTool = frontendToolNames.has(toolName);
              const toolUseId = _resolveToolUseId({
                seen: toolCallsSeen,
                toolName,
                nativeToolUseId,
                fallbackToolUseId: strandsToolId,
                isFrontendTool,
                priorToolCallIds,
                onNewFrontendCall: recordFrontendCall,
              });
              const argsStr =
                typeof parsedInput === "string"
                  ? parsedInput
                  : JSON.stringify(parsedInput);

              if (!toolCallsSeen.has(toolUseId)) {
                toolCallsSeen.set(toolUseId, {
                  name: toolName,
                  args: argsStr,
                  input: parsedInput,
                  emitted: false,
                  strandsToolId,
                  raw: rawInput,
                });
              } else {
                const entry = toolCallsSeen.get(toolUseId)!;
                entry.args = argsStr;
                entry.input = parsedInput;
                entry.raw = rawInput;
              }

              const entry = toolCallsSeen.get(toolUseId)!;
              const behavior = this.config.toolBehaviors?.[toolName];
              this._log.debug(
                `${LOG_PREFIX} contentBlockStop close: toolName=${toolName}, ` +
                  `toolUseId=${toolUseId}, isFrontendTool=${isFrontendTool}, ` +
                  `isPending=${entry.isPending ?? false}, useStreaming=${entry.useStreaming ?? false}, ` +
                  `threadId=${inputData.threadId}`,
              );

              if (entry.startEmitted && entry.useStreaming) {
                // Streaming path — PredictState + TOOL_CALL_START + per-delta
                // TOOL_CALL_ARGS already went on the wire. Flush any final
                // delta, then close the call.
                const lastLen = entry.lastEmittedRawLen ?? 0;
                if (rawInput.length > lastLen) {
                  yield {
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId: toolUseId,
                    delta: rawInput.slice(lastLen),
                  };
                  entry.lastEmittedRawLen = rawInput.length;
                }

                // stateFromArgs BEFORE TOOL_CALL_END: CopilotKit v2 releases
                // the predict_state buffer at TOOL_CALL_END. Delivering the
                // snapshot first means the FE has authoritative state in
                // hand at the moment prediction is released.
                if (behavior?.stateFromArgs) {
                  const callCtx: ToolCallContext = {
                    inputData,
                    toolName,
                    toolUseId,
                    toolInput: parsedInput,
                    argsStr,
                    ...buildContextExtras(inputData),
                  };
                  try {
                    const snapshot = await maybeAwait(
                      behavior.stateFromArgs(callCtx),
                    );
                    if (snapshot) {
                      Object.assign(currentState, snapshot);
                      yield { type: EventType.STATE_SNAPSHOT, snapshot };
                    }
                  } catch (e) {
                    this._log.error(
                      `${LOG_PREFIX} stateFromArgs failed for ${toolName}:`,
                      e,
                    );
                    yield {
                      type: EventType.CUSTOM,
                      name: "hook_error",
                      value: {
                        hook: "stateFromArgs",
                        tool: toolName,
                        error: _errorMessage(e),
                      },
                    };
                  }
                }

                yield { type: EventType.TOOL_CALL_END, toolCallId: toolUseId };
                entry.endEmitted = true;
                entry.emitted = true;

                // Splice point 2 of 4: append the assistant tool-call entry
                // to the running snapshot, then rotate message_id so the
                // next assistant turn carries a distinct id.
                if (emitMessagesSnapshot && !behavior?.skipMessagesSnapshot) {
                  snapshotMessages.push({
                    id: messageId,
                    role: "assistant",
                    content: "",
                    toolCalls: [
                      {
                        id: toolUseId,
                        type: "function",
                        function: {
                          name: toolName || "unknown",
                          arguments: argsStr || "{}",
                        },
                      },
                    ],
                  } as AguiAssistantMessage);
                  yield {
                    type: EventType.MESSAGES_SNAPSHOT,
                    messages: snapshotMessages.slice(),
                  };
                  messageId = uuid();
                }

                if (isFrontendTool && !behavior?.continueAfterFrontendCall) {
                  this._log.debug(
                    `${LOG_PREFIX} Deferring halt after frontend tool call: ` +
                      `toolName=${toolName}, toolCallId=${toolUseId}, threadId=${inputData.threadId}`,
                  );
                  armFrontendHalt();
                }
              } else {
                // Legacy burst path — behavior.argsStreamer is configured,
                // or a continuation turn where the tool is already resolved.
                yield* this._emitToolCall({
                  inputData,
                  toolUseId,
                  isFrontendTool,
                  pendingToolResultIds,
                  getMessageId: () => messageId,
                  setMessageId: (id: string) => {
                    messageId = id;
                  },
                  getMessageStarted: () => messageStarted,
                  setMessageStarted: (v: boolean) => {
                    messageStarted = v;
                  },
                  getAccumulatedText: () => accumulatedText,
                  setAccumulatedText: (v: string) => {
                    accumulatedText = v;
                  },
                  citations,
                  snapshotMessages,
                  emitMessagesSnapshot,
                  toolCallsSeen,
                  currentState,
                  onPendingHalt: armFrontendHalt,
                });
              }
            }
            continue;
          }

          // ContentBlock yielded post-stream as a completed `ToolUseBlock`.
          // The streaming path above already emitted the envelope via
          // `modelContentBlockStopEvent`; the `emitted` guard inside
          // `_emitToolCall` makes this a no-op when that already happened.
          // This branch also fires when a provider skips delta events
          // entirely (tests, some non-streaming configurations).
          if (kind === "toolUseBlock") {
            const block = event as unknown as ToolUseBlock;
            const isFrontendTool = frontendToolNames.has(block.name);
            // Which of the two this sighting is. Every assembled block is
            // delivered exactly once, so the FIRST assembled sighting of a call
            // already tracked under this native id is that call's re-delivery,
            // and a second sighting under the same id is a different call
            // reusing it. On a provider that emits no deltas this branch is the
            // only place the identity guard can see that reuse at all.
            const tracked = _trackedByNativeId(toolCallsSeen, block.toolUseId);
            const isAssembledRedelivery =
              tracked !== undefined && tracked.assembledSeen !== true;
            const toolUseId = _resolveToolUseId({
              seen: toolCallsSeen,
              toolName: block.name,
              nativeToolUseId: block.toolUseId,
              fallbackToolUseId: block.toolUseId,
              isFrontendTool,
              priorToolCallIds,
              onNewFrontendCall: recordFrontendCall,
              isAssembledRedelivery,
            });
            const argsStr =
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input);
            if (!toolCallsSeen.has(toolUseId)) {
              toolCallsSeen.set(toolUseId, {
                name: block.name,
                args: argsStr,
                input: block.input,
                emitted: false,
                strandsToolId: block.toolUseId,
              });
            } else {
              const e = toolCallsSeen.get(toolUseId)!;
              // Only this same call's own sighting may refresh what it recorded.
              // A block landing on a call whose envelope already closed is a
              // different call, and writing its arguments here would hand them
              // to the closed call's `stateFromResult`, `customResultHandler`
              // and result context as if they were its own.
              if (isAssembledRedelivery || !e.endEmitted) {
                e.args = argsStr;
                e.input = block.input;
              }
            }
            // Spent whichever entry now owns this native id, so a third sighting
            // cannot read as a re-delivery of the second.
            toolCallsSeen.get(toolUseId)!.assembledSeen = true;
            yield* this._emitToolCall({
              inputData,
              toolUseId,
              isFrontendTool,
              pendingToolResultIds,
              getMessageId: () => messageId,
              setMessageId: (id: string) => {
                messageId = id;
              },
              getMessageStarted: () => messageStarted,
              setMessageStarted: (v: boolean) => {
                messageStarted = v;
              },
              getAccumulatedText: () => accumulatedText,
              setAccumulatedText: (v: string) => {
                accumulatedText = v;
              },
              citations,
              snapshotMessages,
              emitMessagesSnapshot,
              toolCallsSeen,
              currentState,
              onPendingHalt: armFrontendHalt,
            });
            continue;
          }

          // Tool results from Strands (backend tools). Maps to Python's
          // `"message" in event and event["message"]["role"] == "user"` branch.
          if (kind === "afterToolCallEvent") {
            const hookEvent = event as unknown as {
              toolUse: { toolUseId: string; name: string };
              /** The tool that ran; absent when registry lookup found none. */
              tool?: unknown;
              result: ToolResultBlock;
            };
            const resultToolId = hookEvent.toolUse.toolUseId;
            const toolName = hookEvent.toolUse.name;

            // Skip the placeholder a proxy tool returns. Keyed on the tool that
            // actually executed rather than on the names this request declared:
            // a proxy registered for an earlier turn outlives the declaration
            // whenever the agent cache is shared across adapter instances
            // (`agentsByThread`), and its placeholder would otherwise reach the
            // client as a genuine result and the model as an answer. The reverse
            // reading matters too: a native tool shadowing a client-declared
            // name owns its result and has to keep delivering it.
            if (isProxyTool(hookEvent.tool)) continue;

            // Parse the content into a usable value. `result.content` is
            // required by the SDK type but can be missing on errors or
            // malformed tools. A void tool call (returns undefined/null) is
            // legitimate — emit an empty TOOL_CALL_RESULT so the UI still
            // renders a result card.
            let resultData: unknown = null;
            const fallbackResultData: unknown[] = [];
            let matchedTextResult = false;
            const contentBlocks = hookEvent.result?.content;
            if (Array.isArray(contentBlocks)) {
              for (const cb of contentBlocks) {
                if (cb instanceof TextBlock) {
                  matchedTextResult = true;
                  try {
                    resultData = JSON.parse(cb.text);
                  } catch {
                    try {
                      resultData = JSON.parse(cb.text.replace(/'/g, '"'));
                    } catch (e) {
                      this._log.warn(
                        `${LOG_PREFIX} tool result JSON parse failed for ${toolName}; using raw text`,
                        e,
                      );
                      resultData = cb.text;
                    }
                  }
                  break;
                }
                const maybeJson = (cb as unknown as { json?: unknown }).json;
                if (maybeJson !== undefined) {
                  fallbackResultData.push(maybeJson);
                  continue;
                }

                const serializableBlock = cb as unknown as {
                  toJSON?: () => unknown;
                };
                fallbackResultData.push(
                  typeof serializableBlock.toJSON === "function"
                    ? serializableBlock.toJSON()
                    : cb,
                );
              }
            }

            if (!matchedTextResult && fallbackResultData.length > 0) {
              resultData =
                fallbackResultData.length === 1
                  ? fallbackResultData[0]
                  : fallbackResultData;
            }

            if (!resultToolId) continue;

            const callInfo = toolCallsSeen.get(resultToolId);
            const toolArgs = callInfo?.args;
            const toolInput = callInfo?.input;
            const behavior = this.config.toolBehaviors?.[toolName];

            this._log.debug(
              `${LOG_PREFIX} Processing tool result: toolName=${toolName}, ` +
                `resultToolId=${resultToolId}, threadId=${inputData.threadId}`,
            );

            // Emit TOOL_CALL_RESULT without a role field so the frontend
            // completes the tool in UI without adding it to the conversation
            // history. A fresh message id ensures CopilotKit creates a
            // standalone ToolMessage and closes the spinner correctly.
            const toolResultMessageId = uuid();
            const toolResultContent = _serializeToolResultData(resultData);
            yield {
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: resultToolId,
              messageId: toolResultMessageId,
              content: toolResultContent,
            };

            // Splice point 3 of 4: append the ToolMessage to the running
            // snapshot so the frontend can pair call + result.
            if (emitMessagesSnapshot && !behavior?.skipMessagesSnapshot) {
              snapshotMessages.push({
                id: toolResultMessageId,
                role: "tool",
                content: toolResultContent,
                toolCallId: resultToolId,
              } as AguiToolMessage);
              yield {
                type: EventType.MESSAGES_SNAPSHOT,
                messages: snapshotMessages.slice(),
              };
            }

            const resultContext: ToolResultContext = {
              inputData,
              toolName,
              toolUseId: resultToolId,
              toolInput,
              argsStr: toolArgs ?? "{}",
              resultData,
              messageId,
              ...buildContextExtras(inputData),
            };

            if (behavior?.stateFromResult) {
              try {
                const snapshot = await maybeAwait(
                  behavior.stateFromResult(resultContext),
                );
                if (snapshot) {
                  Object.assign(currentState, snapshot);
                  yield { type: EventType.STATE_SNAPSHOT, snapshot };
                }
              } catch (e) {
                this._log.error(
                  `${LOG_PREFIX} stateFromResult failed for ${toolName}:`,
                  e,
                );
                yield {
                  type: EventType.CUSTOM,
                  name: "hook_error",
                  value: {
                    hook: "stateFromResult",
                    tool: toolName,
                    error: _errorMessage(e),
                  },
                };
              }
            }

            if (behavior?.customResultHandler) {
              try {
                for await (const customEvent of behavior.customResultHandler(
                  resultContext,
                )) {
                  if (customEvent) yield customEvent;
                }
              } catch (e) {
                this._log.error(
                  `${LOG_PREFIX} customResultHandler failed for ${toolName}:`,
                  e,
                );
                yield {
                  type: EventType.CUSTOM,
                  name: "hook_error",
                  value: {
                    hook: "customResultHandler",
                    tool: toolName,
                    error: _errorMessage(e),
                  },
                };
              }
            }

            if (behavior?.stopStreamingAfterResult) {
              stopModelStreaming = true;
              if (!messageStarted) {
                discardOrphanCitations(
                  citations,
                  `threadId=${inputData.threadId}`,
                  this._log,
                );
              }
              if (messageStarted) {
                const closingCitations = citations.take();
                yield {
                  type: EventType.TEXT_MESSAGE_END,
                  messageId,
                  ...citationMetadata(closingCitations),
                };
                messageStarted = false;
                // Splice point 4 of 4 (early-exit): commit accumulated
                // assistant text into the snapshot.
                if (emitMessagesSnapshot && accumulatedText) {
                  snapshotMessages.push({
                    id: messageId,
                    role: "assistant",
                    content: accumulatedText,
                    ...citationMetadata(
                      copyCitationMetadata(closingCitations, this._log),
                    ),
                  } as AguiAssistantMessage);
                  accumulatedText = "";
                  yield {
                    type: EventType.MESSAGES_SNAPSHOT,
                    messages: snapshotMessages.slice(),
                  };
                }
              }
              this._log.debug(
                `${LOG_PREFIX} Breaking event stream: stopStreamingAfterResult behavior triggered ` +
                  `(threadId=${inputData.threadId}, toolName=${toolName})`,
              );
              haltEventStream = true;
              // A frontend call in the same batch owns how this turn ends: its
              // latch at the end of the batch is what makes Strands persist the
              // `toolUse` and placeholder `toolResult` pair the continuation
              // repairs. Breaking out here would leave nothing persisted, so the
              // loop runs on to that latch with the wire already muted.
              if (pendingHalt) continue;
              break;
            }
            continue;
          }

          // Tools can yield state updates mid-execution as toolStreamEvent.
          if (kind === "toolStreamEvent") {
            const stream = event as unknown as { data?: unknown };
            const data = stream.data;
            const tseToolName = currentToolUse?.name ?? "";
            const tseToolUseId = currentToolUse?.toolUseId;
            const tseBehavior = tseToolName
              ? this.config.toolBehaviors?.[tseToolName]
              : undefined;

            if (tseToolUseId && tseBehavior?.toolStreamEventHandler) {
              try {
                for await (const ev of tseBehavior.toolStreamEventHandler({
                  toolUseId: tseToolUseId,
                  toolName: tseToolName,
                  streamData: data,
                })) {
                  if (ev != null) yield ev;
                }
              } catch (e) {
                this._log.warn(
                  `${LOG_PREFIX} toolStreamEventHandler failed for ${tseToolName}: ${_errorMessage(e)}`,
                );
              }
            } else if (data && typeof data === "object" && "state" in data) {
              yield {
                type: EventType.STATE_SNAPSHOT,
                snapshot: (data as { state: Record<string, unknown> }).state,
              };
            } else if (
              data &&
              typeof data === "object" &&
              A2UI_STREAM_KEY in data
            ) {
              // A2UI sub-agent streaming: re-emit the generate_a2ui
              // tool's inner render_a2ui progress as synthetic TOOL_CALL events.
              // The a2ui middleware's streaming path keys its "building"
              // skeleton + progressive paint off these — without them the
              // surface only paints in bulk from the final TOOL_CALL_RESULT.
              const a2ui = (
                data as {
                  [A2UI_STREAM_KEY]: {
                    kind: "start" | "args" | "end";
                    toolCallId: string;
                    toolCallName?: string;
                    delta?: string;
                  };
                }
              )[A2UI_STREAM_KEY];
              if (a2ui.kind === "start") {
                yield {
                  type: EventType.TOOL_CALL_START,
                  toolCallId: a2ui.toolCallId,
                  toolCallName: a2ui.toolCallName ?? "render_a2ui",
                };
              } else if (a2ui.kind === "args" && a2ui.delta) {
                yield {
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: a2ui.toolCallId,
                  delta: a2ui.delta,
                };
              } else if (a2ui.kind === "end") {
                yield {
                  type: EventType.TOOL_CALL_END,
                  toolCallId: a2ui.toolCallId,
                };
              }
            }
            continue;
          }

          // Multi-agent events (only fire when `agent` is a Graph/Swarm —
          // also possible when an agent wraps a subgraph).
          const maEvent = event as unknown as {
            type?: string;
            nodeId?: string;
            nodeType?: string;
            source?: string;
            targets?: string[];
          };
          if (maEvent?.type === "beforeNodeCallEvent") {
            // stepName must match the paired afterNodeCallEvent below so
            // frontends can pair START/FINISH (events.mdx §StepFinished).
            const stepName = _stepName(maEvent);
            yield { type: EventType.STEP_STARTED, stepName };
            continue;
          }
          if (maEvent?.type === "afterNodeCallEvent") {
            const stepName = _stepName(maEvent);
            yield { type: EventType.STEP_FINISHED, stepName };
            continue;
          }
          if (maEvent?.type === "multiAgentHandoffEvent") {
            // Py wire shape: { from_nodes, to_nodes, message }. TS SDK gives
            // `source` + `targets`; wrap source in an array to preserve the
            // Py shape so downstream consumers don't need per-backend branching.
            const handoffMsg = (maEvent as { message?: string }).message;
            yield {
              type: EventType.CUSTOM,
              name: "MultiAgentHandoff",
              value: {
                from_nodes: maEvent.source ? [maEvent.source] : [],
                to_nodes: maEvent.targets ?? [],
                message: handoffMsg,
              },
            };
            continue;
          }

          // Per-call token usage. One entry per model invocation, which is why
          // this reads the metadata event rather than the terminal result's
          // pre-summed `accumulatedUsage`. No `continue`: the same event is
          // deliberately forwarded as RAW below, since its latency metrics have
          // no AG-UI equivalent and dropping them would trade one report for
          // another.
          if (kind === "modelMetadataEvent") {
            const entry = tokenUsageFromStrandsUsage(
              (event as { usage?: unknown }).usage,
              modelIdentity,
            );
            if (entry) runUsage.push(entry);
          }

          // Terminal `AgentResult`. Mirrors Python's `"result" in event`
          // branch: a non-normal stop gets a hint event so a client can say
          // why an answer is short or empty, instead of the run reading as an
          // ordinary success. No `continue`: the RAW skip list below owns
          // dropping the result itself, whose payload already streamed.
          if (kind === "agentResultEvent") {
            const stopReason = (event as { result?: { stopReason?: unknown } })
              .result?.stopReason;
            const hint =
              typeof stopReason === "string"
                ? ABNORMAL_STOP_REASONS.get(stopReason)
                : undefined;
            if (hint) {
              // Python logs the terminal result at INFO. This `Logger` has no
              // info level and `DEFAULT_LOGGER.debug` is a no-op, so logging an
              // abnormal stop at debug would leave no server trace at all.
              // `warn` is the lowest level the default logger actually emits,
              // and a truncated or filtered answer is a warning. The normal
              // stops keep the debug trace so an ordinary run stays quiet.
              this._log.warn(
                `${LOG_PREFIX} agent_result: threadId=${threadId}, ` +
                  `stopReason=${String(stopReason)} (abnormal stop)`,
              );
              yield _agentStopped(hint);
            } else {
              this._log.debug(
                `${LOG_PREFIX} agent_result: threadId=${threadId}, ` +
                  `stopReason=${String(stopReason)}`,
              );
            }
          }

          // Terminal fallback: anything the dispatch above does not translate
          // is forwarded verbatim as RAW rather than dropped without a trace
          // (issue #2291). Provider extensions this adapter predates arrive
          // here. Bedrock citations no longer do: the delta branch above maps
          // them onto the message they annotate, so they are no longer among
          // the events this adapter has no branch for. Mirrors the Python
          // adapter's terminal `else`, and matches what every other streaming
          // adapter (LangGraph, watsonx, a2a) already does. The lifecycle
          // brackets in `RAW_SKIPPED_EVENT_KINDS` stay silent, as in Python.
          if (kind && RAW_SKIPPED_EVENT_KINDS.has(kind)) continue;
          // An assembled content block duplicates content already on the wire,
          // whatever kind of block it turned out to be. Keyed on the wrapper
          // rather than on a list of block names so a block type added by a
          // future SDK release is covered the day it ships.
          if (isAssembledBlock) {
            this._log.debug(
              `${LOG_PREFIX} Skipping assembled content block for RAW ` +
                `forwarding; its content already streamed ` +
                `(threadId=${inputData.threadId}, block=${kind ?? "unknown"})`,
            );
            continue;
          }
          const rawPayload = sanitizeRawEvent(event);
          if (rawPayload === undefined) {
            this._log.warn(
              `${LOG_PREFIX} Dropping unserializable Strands event from RAW ` +
                `forwarding (threadId=${inputData.threadId}, kind=${kind ?? "unknown"})`,
            );
            continue;
          }
          this._log.debug(
            `${LOG_PREFIX} Unmapped Strands event forwarded as RAW ` +
              `(threadId=${inputData.threadId}, kind=${kind ?? "unknown"})`,
          );
          yield {
            type: EventType.RAW,
            event: rawPayload,
            source: "strands",
          } as unknown as BaseEvent;
        }
      } finally {
        // Consumer bailed (client disconnect, frontend-tool halt, error).
        // Fire the abort signal so Strands stops its Bedrock fetch at the
        // next checkpoint, then drain the generator so cleanup hooks run.
        try {
          runAbort.abort();
        } catch {
          // ignore
        }
        // A model call abandoned mid-flight never reaches its after-hook, so
        // the block it was shown is still in `agent.messages`. Take it out
        // before the drain: returning the stream runs the after-invocation
        // hooks, and a session manager snapshots `agent.messages` from there,
        // so a restore that ran afterwards would come too late for the store.
        // Idempotent when the hook already ran. Python restores from the same
        // teardown `finally`.
        restoreTransientModelContext(strandsAgent);
        try {
          await agentStream.return(undefined as never);
        } catch {
          // ignore — cancellation typically surfaces as CancelledError
        }
      }

      // The turn ends with the assistant `toolUse` and its placeholder
      // `toolResult`, exactly the reinvokable pair Strands persists after any
      // tool batch. Drop the assistant text `endTurn` added on top: the client
      // is still executing the tool, and replaying a trailing assistant turn to
      // the model on the continuation would ask it to continue that sentence.
      if (frontendHalt) {
        _dropFrontendHaltTurn(strandsAgent);
        if (sessionManager) {
          try {
            await sessionManager.saveSnapshot({
              target: strandsAgent,
              isLatest: true,
            });
          } catch (e) {
            // A broken backing store must not turn a delivered tool call into a
            // failed run. The client still answers, and the continuation then
            // fails closed on a result it cannot name.
            this._log.warn(
              `${LOG_PREFIX} Failed to persist the halted turn: ${_errorMessage(e)}`,
            );
          }
        }
      }

      if (reasoningStarted) {
        yield {
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId!,
        };
        yield { type: EventType.REASONING_END, messageId: reasoningMessageId! };
      }

      // A turn that cited without producing any text has nothing to attach
      // them to, so they are dropped loudly rather than carried forward.
      if (!messageStarted) {
        discardOrphanCitations(
          citations,
          `threadId=${inputData.threadId}`,
          this._log,
        );
      }
      if (messageStarted) {
        const closingCitations = citations.take();
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId,
          ...citationMetadata(closingCitations),
        };
        // Splice point 4 of 4 (terminal): commit the final assistant text
        // turn into the snapshot.
        if (emitMessagesSnapshot && accumulatedText) {
          snapshotMessages.push({
            id: messageId,
            role: "assistant",
            content: accumulatedText,
            ...citationMetadata(
              copyCitationMetadata(closingCitations, this._log),
            ),
          } as AguiAssistantMessage);
          accumulatedText = "";
          yield {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: snapshotMessages.slice(),
          };
        }
      }

      // Close out any tool calls still in flight before RUN_FINISHED. On the
      // halt path (stopStreamingAfterResult) the break above exits the loop
      // with sibling parallel calls that emitted TOOL_CALL_START but never
      // reached their TOOL_CALL_END; the normal path drains nothing (all ends
      // already emitted). Either way the verifier must see zero active calls.
      yield* _drainPendingToolCalls(toolCallsSeen);

      // A forced stop is a failed run, not a short success, so it terminates
      // here rather than falling through to STATE_SNAPSHOT and RUN_FINISHED.
      // Same code and same message as Python, and in the same position
      // relative to the closeout events above.
      if (forcedStop.pending) {
        yield* forcedStop.emit(runUsage);
        return;
      }

      // Streaming can create a mixed checkpoint that preflight could not
      // observe. Advertising one promises a resume may finish it, so this gate
      // asks exactly what the resume gates ask, in their order: a checkpoint
      // advertised here and then refused on resume wedges the thread, since the
      // refusal keeps it activated and every later plain run meets it.
      //
      // A parked stub no rewrite can correct is refused on resume however many
      // results the turn carries, cancelled entries included, so it is refused
      // here under the resume's own code. One such stub condemns the batch, as
      // it does on the resume side: a resume consumes the parked batch entire.
      const unrepairableParkedIds =
        uncorrectableProxyPlaceholderIds(strandsAgent);
      if (unrepairableParkedIds.size > 0) {
        this._log.error(
          `${LOG_PREFIX} Checkpoint parks proxy placeholders no rewrite can ` +
            `correct, so no resume could complete it: native ids ` +
            `${JSON.stringify([...unrepairableParkedIds].sort())}`,
        );
        _abandonUnadvertisedCheckpoint(strandsAgent);
        this._pendingInterruptsByThread.delete(threadId);
        yield _interruptReconciliationError(runUsage);
        return;
      }
      // An exact stub the resume WILL repair still repairs only through the
      // session-manager boundary a safe resume needs, so a checkpoint parking
      // one without that boundary is no more advertisable.
      if (activeProxyPlaceholderIds(strandsAgent).size > 0) {
        if (!sessionManager) {
          _abandonUnadvertisedCheckpoint(strandsAgent);
          this._pendingInterruptsByThread.delete(threadId);
          yield _interruptSessionRequiredError(runUsage);
          return;
        }
        if (
          !supportsSnapshotReconciliation(
            sessionManager,
            strandsAgent,
            this._log,
          )
        ) {
          _abandonUnadvertisedCheckpoint(strandsAgent);
          this._pendingInterruptsByThread.delete(threadId);
          yield _interruptSessionCapabilityError(runUsage);
          return;
        }
      }

      // Final state snapshot with `currentState` verbatim. Unlike the initial
      // snapshot this is not filtered — the initial filter exists only to
      // protect frontends that don't recognise the "tool" role.
      yield { type: EventType.STATE_SNAPSHOT, snapshot: currentState };

      // Interrupt-variant RUN_FINISHED. The STATE_SNAPSHOT +
      // MESSAGES_SNAPSHOT above precede this per interrupts.mdx §"State at
      // the interrupt boundary". Full interrupt objects are recorded on
      // `_pendingInterruptsByThread` for the `run()` resume gate.
      if (finalAgentResult?.stopReason === "interrupt") {
        const strandsInterrupts = finalAgentResult.interrupts ?? [];
        if (strandsInterrupts.length > 0) {
          const aguiInterrupts = strandsInterrupts.map((raised) =>
            strandsInterruptToAgui(raised, this._log),
          );
          const interruptMap = new Map<string, AguiInterrupt>();
          for (const i of aguiInterrupts) interruptMap.set(i.id, i);
          this._pendingInterruptsByThread.set(threadId, interruptMap);
          this._lastResumeFingerprint.delete(threadId);
          persistInterruptBookkeeping(
            strandsAgent,
            interruptMap,
            null,
            this._log,
          );
          // Strands' default SessionManager saves at the completed-invocation
          // boundary. An interrupt exits the native loop before that durable
          // snapshot is guaranteed, so explicitly checkpoint the restored
          // native interrupt state and our appState bookkeeping before telling
          // the client it may resume after a process restart.
          try {
            await strandsAgent.sessionManager?.saveSnapshot({
              target: strandsAgent,
              isLatest: true,
            });
          } catch (e) {
            // Persistence is a durability enhancement. A broken backing store
            // must not turn a successfully-raised interrupt into a failed run.
            this._log.warn(
              `${LOG_PREFIX} Failed to persist interrupt snapshot: ${_errorMessage(e)}`,
            );
          }
          // An interrupted run is a finished run as far as usage goes: the
          // model calls that got it here were real, and the resume that
          // continues the turn reports its own.
          yield {
            type: EventType.RUN_FINISHED,
            threadId: inputData.threadId,
            runId: inputData.runId,
            outcome: {
              type: "interrupt",
              interrupts: aguiInterrupts,
            },
            ..._runUsage(runUsage),
          };
          return;
        }
        // The run reported an interrupt and handed back nothing. Where the
        // checkpoint is still parked, this finish is indistinguishable from a
        // real success in the event stream, so it is recorded rather than
        // inferred: remembering it as a completed resume would let a retry be
        // answered from the fingerprint without ever reaching the parked tool.
        //
        // The stop reason alone is not enough to record it. A run that left no
        // active checkpoint behind has finished its work, and withholding the
        // fingerprint there would cost the client its idempotent retry and
        // leave the answered interrupt recorded as pending.
        //
        // Not the same test the Python adapter applies, and the difference is
        // upstream of this line rather than in it. That side falls back to the
        // live checkpoint when the terminal result reports nothing, so a
        // checkpoint still holding an unanswered interrupt is republished there
        // as a pending-interrupt outcome, where this side reports a plain
        // finish. Both then withhold the fingerprint, so neither answers a
        // retry from it, but the events a client sees are not identical.
        // Closing that would mean changing what this side reports, which is a
        // wider change than the resume contract.
        const parked =
          (
            strandsAgent as unknown as {
              _interruptState?: { activated?: boolean };
            }
          )._interruptState?.activated === true;
        pausedWithNothingToReport = parked;
        this._log.debug(
          `${LOG_PREFIX} Strands stopped for an interrupt with an empty interrupts list; reporting no pending interrupts`,
        );
      }

      // The pause fact travels with the finish it describes. A symbol key so it
      // cannot collide with the event schema and does not survive JSON, which
      // keeps it off the wire; `run()` reads it before any transform runs.
      yield {
        type: EventType.RUN_FINISHED,
        threadId: inputData.threadId,
        runId: inputData.runId,
        outcome: { type: "success" },
        ..._runUsage(runUsage),
        ...(pausedWithNothingToReport ? { [PAUSED_PARKED]: true } : {}),
      };
    } catch (e) {
      const code = _terminalErrorCode(e);
      this._log.error(`${LOG_PREFIX} _runSingleAgent failed:`, e);
      yield _runError(_errorMessage(e), code, runUsage);
    }
  }

  /**
   * Legacy burst path for tool calls — invoked when the Strands SDK delivers
   * a complete `ToolUseBlock` or when a `ToolBehavior.argsStreamer` takes
   * over args emission at contentBlockStop.
   *
   * The streaming path inside `_runSingleAgent` handles the common case
   * directly; this helper handles continuation turns and custom streamers.
   *
   * Getters/setters surface the caller's local variables because JS closures
   * capture by reference only for `const` / `let` in scope — an object of
   * mutable fields would work but would require threading `state` through
   * `_runSingleAgent`'s long body.
   */
  private async *_emitToolCall(ctx: {
    inputData: RunAgentInput;
    toolUseId: string;
    isFrontendTool: boolean;
    pendingToolResultIds: Set<string>;
    getMessageId: () => string;
    setMessageId: (id: string) => void;
    getMessageStarted: () => boolean;
    setMessageStarted: (v: boolean) => void;
    getAccumulatedText: () => string;
    setAccumulatedText: (v: string) => void;
    citations: CitationAccumulator;
    snapshotMessages: AguiMessage[];
    emitMessagesSnapshot: boolean;
    toolCallsSeen: Map<string, SeenToolCall>;
    currentState: Record<string, unknown>;
    onPendingHalt: () => void;
  }): AsyncGenerator<BaseEvent, void, void> {
    const entry = ctx.toolCallsSeen.get(ctx.toolUseId);
    if (!entry || entry.emitted) return;
    entry.emitted = true;
    const toolName = entry.name;
    const argsStr = entry.args;
    const toolInput = entry.input;
    const behavior = this.config.toolBehaviors?.[toolName];
    const isPending = ctx.pendingToolResultIds.has(ctx.toolUseId);

    const callContext: ToolCallContext = {
      inputData: ctx.inputData,
      toolName,
      toolUseId: ctx.toolUseId,
      toolInput,
      argsStr,
      ...buildContextExtras(ctx.inputData),
    };

    // Continuation turn — tool already resolved in conversation history.
    // Don't re-emit wire events, but fire state callbacks so derived state
    // stays consistent.
    if (isPending) {
      if (behavior?.stateFromArgs) {
        try {
          const snapshot = await maybeAwait(
            behavior.stateFromArgs(callContext),
          );
          if (snapshot) {
            Object.assign(ctx.currentState, snapshot);
            yield { type: EventType.STATE_SNAPSHOT, snapshot };
          }
        } catch (e) {
          this._log.error(
            `${LOG_PREFIX} stateFromArgs failed for ${toolName}:`,
            e,
          );
          yield {
            type: EventType.CUSTOM,
            name: "hook_error",
            value: {
              hook: "stateFromArgs",
              tool: toolName,
              error: _errorMessage(e),
            },
          };
        }
      }
      return;
    }

    // stateFromArgs BEFORE TOOL_CALL_START seeds the frontend's derived
    // state before the predict_state buffer opens.
    if (behavior?.stateFromArgs) {
      try {
        const snapshot = await maybeAwait(behavior.stateFromArgs(callContext));
        if (snapshot) {
          Object.assign(ctx.currentState, snapshot);
          yield { type: EventType.STATE_SNAPSHOT, snapshot };
        }
      } catch (e) {
        this._log.error(
          `${LOG_PREFIX} stateFromArgs failed for ${toolName}:`,
          e,
        );
        yield {
          type: EventType.CUSTOM,
          name: "hook_error",
          value: {
            hook: "stateFromArgs",
            tool: toolName,
            error: _errorMessage(e),
          },
        };
      }
    }

    if (behavior) {
      const predict = normalizePredictState(behavior.predictState).map(
        predictStateMappingToPayload,
      );
      if (predict.length > 0) {
        yield { type: EventType.CUSTOM, name: "PredictState", value: predict };
      }
    }

    // Close any open assistant text turn and commit its content to the
    // snapshot before rotating message_id.
    if (!ctx.getMessageStarted()) {
      discardOrphanCitations(
        ctx.citations,
        `threadId=${ctx.inputData.threadId}`,
        this._log,
      );
    }
    if (ctx.getMessageStarted()) {
      const closingCitations = ctx.citations.take();
      yield {
        type: EventType.TEXT_MESSAGE_END,
        messageId: ctx.getMessageId(),
        ...citationMetadata(closingCitations),
      };
      const acc = ctx.getAccumulatedText();
      if (ctx.emitMessagesSnapshot && acc) {
        ctx.snapshotMessages.push({
          id: ctx.getMessageId(),
          role: "assistant",
          content: acc,
          ...citationMetadata(
            copyCitationMetadata(closingCitations, this._log),
          ),
        } as AguiAssistantMessage);
        ctx.setAccumulatedText("");
        yield {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: ctx.snapshotMessages.slice(),
        };
      }
      ctx.setMessageStarted(false);
      ctx.setMessageId(uuid());
    }

    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: ctx.toolUseId,
      toolCallName: toolName,
      parentMessageId: ctx.getMessageId(),
    };
    entry.startEmitted = true;

    let streamerFailed = false;
    if (behavior?.argsStreamer) {
      try {
        for await (const chunk of behavior.argsStreamer(callContext)) {
          if (chunk == null) continue;
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: ctx.toolUseId,
            delta: String(chunk),
          };
        }
      } catch (e) {
        streamerFailed = true;
        this._log.error(
          `${LOG_PREFIX} argsStreamer failed for ${toolName}:`,
          e,
        );
        yield {
          type: EventType.CUSTOM,
          name: "hook_error",
          value: {
            hook: "argsStreamer",
            tool: toolName,
            error: _errorMessage(e),
          },
        };
      }
    } else {
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: ctx.toolUseId,
        delta: argsStr,
      };
    }

    if (streamerFailed) {
      yield { type: EventType.TOOL_CALL_END, toolCallId: ctx.toolUseId };
      entry.endEmitted = true;
      // The call still went out, so the client still owes an answer and the halt
      // still has to fire. Returning without arming it lets Strands run on and
      // feed the model the proxy's placeholder as that answer.
      if (ctx.isFrontendTool && !behavior?.continueAfterFrontendCall) {
        this._log.debug(
          `${LOG_PREFIX} Deferring halt after frontend tool call: ` +
            `toolName=${toolName}, toolCallId=${ctx.toolUseId}, threadId=${ctx.inputData.threadId}`,
        );
        ctx.onPendingHalt();
      }
      return;
    }

    yield { type: EventType.TOOL_CALL_END, toolCallId: ctx.toolUseId };
    entry.endEmitted = true;

    // Splice point 2 of 4: append the assistant tool-call entry to the
    // snapshot, then rotate message_id.
    if (ctx.emitMessagesSnapshot && !behavior?.skipMessagesSnapshot) {
      ctx.snapshotMessages.push({
        id: ctx.getMessageId(),
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: ctx.toolUseId,
            type: "function",
            function: {
              name: toolName || "unknown",
              arguments: argsStr || "{}",
            },
          },
        ],
      } as AguiAssistantMessage);
      yield {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: ctx.snapshotMessages.slice(),
      };
      ctx.setMessageId(uuid());
    }

    if (ctx.isFrontendTool && !behavior?.continueAfterFrontendCall) {
      this._log.debug(
        `${LOG_PREFIX} Deferring halt after frontend tool call: ` +
          `toolName=${toolName}, toolCallId=${ctx.toolUseId}, threadId=${ctx.inputData.threadId}`,
      );
      ctx.onPendingHalt();
    }
  }

  /**
   * Orchestrator-mode run loop. TypeScript-only: drives a `Graph` or `Swarm`
   * `.stream()` call and translates multi-agent events. Per-thread caching,
   * session managers, and proxy-tool sync don't apply.
   */
  private async *_runOrchestrator(
    inputData: RunAgentInput,
    threadId: string,
  ): AsyncGenerator<BaseEvent, void, void> {
    // Provider-reported usage for the whole orchestrator run, one entry per
    // model call. Local, so it is seeded per run the same way the single-agent
    // path's is, and declared outside the try so the terminal RUN_ERROR in its
    // catch reports what the nodes that did run had already spent.
    const runUsage: TokenUsage[] = [];
    // Labels per node, since a Graph or Swarm can run a different model at each
    // one and summing them together would report spend against a model that
    // never made the call. A node's `beforeModelCallEvent` carries the `Model`
    // and arrives before that node's `modelMetadataEvent`, which is the only
    // place the pairing is available: the metadata event itself carries counts
    // and nothing that identifies the model. Only the labels are kept, never
    // the model object.
    const nodeIdentities = new Map<string, StrandsModelIdentity>();

    yield _runStarted(inputData);
    try {
      const initialSnapshot = _stateSnapshotPayload(inputData.state);
      if (initialSnapshot !== undefined) {
        yield { type: EventType.STATE_SNAPSHOT, snapshot: initialSnapshot };
      }

      // Orchestrators take string | ContentBlock[] (MultiAgentInput); extract
      // text from the last user/tool turn.
      let prompt = "Hello";
      if (inputData.messages) {
        for (let i = inputData.messages.length - 1; i >= 0; i--) {
          const msg = inputData.messages[i];
          if (!msg) break;
          if (
            (msg.role === "user" || msg.role === "tool") &&
            msg.content != null
          ) {
            prompt =
              typeof msg.content === "string"
                ? msg.content
                : flattenContentToText(msg.content);
            break;
          }
        }
      }

      let messageId = uuid();
      let messageStarted = false;
      let reasoningStarted = false;
      let reasoningMessageId: string | undefined;
      // This path has no message snapshot to fall back on, so the citations of
      // a node's answer only reach the client through its own message events.
      //
      // One accumulator, not one per node, because this path already gives the
      // whole orchestrator run a single rotating message id rather than a
      // message per node. Citations follow the message they annotate, so they
      // follow that. The Python adapter keys both per node, which is the
      // pre-existing orchestrator drift between the two bridges rather than
      // anything citations introduce.
      const citations = new CitationAccumulator(this._log);

      // The application's context, shown to each leaf agent's model for one
      // call and withdrawn again, as on the single-agent path. Hooks go on the
      // leaves because that is where the model calls are; the orchestrator
      // itself makes none. An orchestrator with no reachable leaf (a
      // hand-rolled one, a remote node) can only receive context in its task
      // input, so the block is prefixed onto the prompt instead and cleared,
      // which is Python's fallback too. Python additionally refuses that
      // fallback during an interrupt resume; this path has no resume arm, so
      // there is nothing here to refuse.
      let contextBlock = formatAguiContext(
        normalizeAguiContext(inputData.context),
      );
      const installedHooks = installOrchestratorContextHooks(
        this._orchestrator,
      );
      if (contextBlock && installedHooks === 0) {
        prompt = `${contextBlock}\n\n${prompt}`;
        contextBlock = "";
      }

      const orchestratorStream = this._orchestrator!.stream(prompt);
      // A throw out of this stream reaches the outer handler below and is
      // reported as STRANDS_ERROR, not under the forced-stop code the
      // single-agent path uses, because the failures that get here are not
      // model stop reasons.
      //
      // `Node.stream` (`multiagent/nodes.js`) wraps `handle()` in a try/catch
      // and turns ANY throw out of a node into a FAILED `NodeResult`, then
      // returns normally. A provider failure inside a Graph node therefore
      // never escapes as an exception at all. What does escape a real `Graph`
      // or `Swarm` is an orchestration budget violation: `maxSteps`
      // ("max steps reached"), the wall-clock `timeout` and the per-node
      // `nodeTimeout` each throw out of `stream()`. Reporting one of those as
      // a forced stop would tell a client the model stopped the run when the
      // orchestrator's own budget did.
      //
      // The abnormal-stop hint further down is a different signal and IS at
      // parity with the single-agent path: it rides a node's terminal
      // `agentResultEvent`, which a real Graph does deliver.
      //
      // The consequence is that a Graph whose node failed reports as a
      // finished run with no error, which is a real gap this adapter does not
      // close. The signals to close it already arrive here and are discarded:
      // `nodeResultEvent` carries `result.error`, `afterNodeCallEvent` carries
      // `.error` when the failure escaped the node, and `for await` drops the
      // aggregate `MultiAgentResult` the stream returns on `{ done: true }`.
      // The aggregate STATUS is the one signal that cannot simply be acted on:
      // `_resolveStatus` (`multiagent/state.js`) marks it FAILED when ANY node
      // failed, so a Graph that lost one parallel branch and answered from
      // another is FAILED too. What a partially failed Graph owes a client is a
      // design question, not missing plumbing. See `ARCHITECTURE.md`.
      try {
        for await (const rawEvent of _foreignStreamFaults(
          orchestratorStream,
          contextBlock,
        )) {
          const event = unwrapStrandsEvent(rawEvent);
          const kind = getEventKind(event);

          if (kind === "beforeNodeCallEvent") {
            const ev = event as { nodeId?: string; nodeType?: string };
            // stepName must match the paired afterNodeCallEvent below so
            // frontends can pair START/FINISH (events.mdx §StepFinished).
            const stepName = _stepName(ev);
            yield { type: EventType.STEP_STARTED, stepName };
            continue;
          }
          if (kind === "afterNodeCallEvent") {
            const ev = event as { nodeId?: string; nodeType?: string };
            if (!messageStarted) {
              discardOrphanCitations(
                citations,
                `threadId=${inputData.threadId}`,
                this._log,
              );
            }
            if (messageStarted) {
              yield {
                type: EventType.TEXT_MESSAGE_END,
                messageId,
                ...citationMetadata(citations.take()),
              };
              messageStarted = false;
              messageId = uuid();
            }
            if (reasoningStarted) {
              yield {
                type: EventType.REASONING_MESSAGE_END,
                messageId: reasoningMessageId!,
              };
              yield {
                type: EventType.REASONING_END,
                messageId: reasoningMessageId!,
              };
              reasoningStarted = false;
              reasoningMessageId = undefined;
            }
            const stepName = _stepName(ev);
            yield { type: EventType.STEP_FINISHED, stepName };
            continue;
          }
          if (kind === "multiAgentHandoffEvent") {
            const ev = event as {
              source?: string;
              targets?: string[];
              message?: string;
            };
            yield {
              type: EventType.CUSTOM,
              name: "MultiAgentHandoff",
              value: {
                from_nodes: ev.source ? [ev.source] : [],
                to_nodes: ev.targets ?? [],
                message: ev.message,
              },
            };
            continue;
          }
          if (kind === "nodeStreamUpdateEvent") {
            // Inner event is the agent-level event emitted by the wrapped agent.
            const ev = event as {
              nodeId?: string;
              inner?: { source?: string; event?: unknown };
            };
            const inner = ev.inner?.event
              ? unwrapStrandsEvent(ev.inner.event)
              : undefined;
            const innerKind = getEventKind(inner);
            // A node's terminal `AgentResult` is the only place a stop reason
            // reaches this path: `Agent.stream()` yields an `agentResultEvent`,
            // and `AgentNode.handle` wraps every event it yields in a
            // `NodeStreamUpdateEvent` tagged `source: 'agent'`. A non-normal
            // stop gets the same hint the single-agent path emits, so a client
            // can say why an answer is short or empty instead of reading the
            // node as an ordinary success.
            if (innerKind === "agentResultEvent") {
              const stopReason = (
                inner as { result?: { stopReason?: unknown } }
              ).result?.stopReason;
              const hint =
                typeof stopReason === "string"
                  ? ABNORMAL_STOP_REASONS.get(stopReason)
                  : undefined;
              if (hint) {
                // Same level as the single-agent path, and for the same
                // reason: `DEFAULT_LOGGER.debug` is a no-op, so an abnormal
                // stop logged at debug leaves no server trace at all, and a
                // guardrailed or filtered answer is a warning. Normal stops
                // keep the debug trace so an ordinary run stays quiet.
                this._log.warn(
                  `${LOG_PREFIX} node agent_result: threadId=${threadId}, ` +
                    `nodeId=${ev.nodeId ?? "unknown"}, stopReason=${String(stopReason)} ` +
                    `(abnormal stop)`,
                );
                yield _agentStopped(hint);
              } else {
                this._log.debug(
                  `${LOG_PREFIX} node agent_result: threadId=${threadId}, ` +
                    `nodeId=${ev.nodeId ?? "unknown"}, stopReason=${String(stopReason)}`,
                );
              }
              continue;
            }
            if (innerKind === "beforeModelCallEvent") {
              nodeIdentities.set(
                ev.nodeId ?? "",
                strandsModelIdentity((inner as { model?: unknown }).model),
              );
              continue;
            }
            if (innerKind === "modelMetadataEvent") {
              const entry = tokenUsageFromStrandsUsage(
                (inner as { usage?: unknown }).usage,
                nodeIdentities.get(ev.nodeId ?? "") ?? {},
              );
              if (entry) runUsage.push(entry);
              continue;
            }
            if (innerKind === "modelContentBlockDeltaEvent") {
              const delta = (
                inner as { delta?: { type?: string; text?: string } }
              ).delta;
              if (delta?.type === "textDelta" && delta.text) {
                if (!messageStarted) {
                  yield {
                    type: EventType.TEXT_MESSAGE_START,
                    messageId,
                    role: "assistant",
                  };
                  messageStarted = true;
                }
                citations.advance(delta.text);
                yield {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId,
                  delta: delta.text,
                  ...citationMetadata(citations.pending()),
                };
              } else if (citations.add(delta)) {
                // Held until this node's message publishes it, same as the
                // single-agent path.
              } else if (
                delta?.type === "reasoningContentDelta" &&
                delta.text
              ) {
                if (!reasoningStarted) {
                  reasoningMessageId = uuid();
                  yield {
                    type: EventType.REASONING_START,
                    messageId: reasoningMessageId,
                  };
                  yield {
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: reasoningMessageId,
                    role: "reasoning",
                  };
                  reasoningStarted = true;
                }
                yield {
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageId!,
                  delta: delta.text,
                };
              }
            }
            continue;
          }
        }
      } finally {
        // A leaf abandoned mid-model-call never reached its after-hook; take
        // the block back off every hooked leaf before the drain, because
        // returning the stream runs each leaf's after-invocation hooks and a
        // session manager snapshots the leaf's `messages` from there. Python's
        // `_restore_orchestrator_context` runs from the same teardown.
        restoreOrchestratorContext(this._orchestrator);
        try {
          await orchestratorStream.return(undefined as never);
        } catch {
          // ignore
        }
      }

      if (!messageStarted) {
        discardOrphanCitations(
          citations,
          `threadId=${inputData.threadId}`,
          this._log,
        );
      }
      if (messageStarted) {
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId,
          ...citationMetadata(citations.take()),
        };
      }
      if (reasoningStarted) {
        yield {
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId!,
        };
        yield { type: EventType.REASONING_END, messageId: reasoningMessageId! };
      }
      yield { type: EventType.STATE_SNAPSHOT, snapshot: {} };
      yield {
        type: EventType.RUN_FINISHED,
        threadId: inputData.threadId,
        runId: inputData.runId,
        outcome: { type: "success" },
        ..._runUsage(runUsage),
      };
    } catch (e) {
      const code = _terminalErrorCode(e);
      this._log.error(`${LOG_PREFIX} _runOrchestrator failed:`, e);
      // A budget violation escapes mid-run, so the nodes that already ran
      // report what they spent.
      yield _runError(_errorMessage(e), code, runUsage);
    }
  }

  /**
   * Name the template settings that will not reach this thread's agent.
   *
   * Said once per setting, and only about settings this thread's config did
   * not supply, so acting on it makes it stop without the first thread
   * becoming the policy for every later one.
   */
  private _reportUncarried(callerConfig?: Partial<AgentConfig>): void {
    const supplied = new Set(Object.keys(callerConfig ?? {}));
    const unreported = (fields: readonly string[]) =>
      fields.filter(
        (field) => !supplied.has(field) && !this._reportedUncarried.has(field),
      );

    const set = unreported(this._uncarriedSetFields);
    if (set.length > 0) {
      for (const field of set) this._reportedUncarried.add(field);
      this._log.warn(
        `${LOG_PREFIX} these settings are on the template but do not reach ` +
          `per-thread agents: ${set.join(", ")}. Supply them per thread with ` +
          "StrandsAgentConfig.threadAgentConfig.",
      );
    }

    const defaults = unreported(this._uncarriedDefaultFields);
    if (defaults.length > 0) {
      for (const field of defaults) this._reportedUncarried.add(field);
      this._log.debug(
        `${LOG_PREFIX} not shared with per-thread agents: ` +
          `${defaults.join(", ")}. Each is wired to the Agent that owns it, so ` +
          "one instance cannot serve every thread. Supply them per thread " +
          "with StrandsAgentConfig.threadAgentConfig.",
      );
    }
  }

  private _buildThreadAgentConfig(
    sessionManager?: SessionManager,
    seedMessages?: AgentConfig["messages"],
    callerConfig?: Partial<AgentConfig>,
  ): AgentConfig {
    const t = this._templateFields;
    // Every "copy" field the template carried, without naming them one by one:
    // the plan above decides what lands here, so a field added to the SDK and
    // classified as copyable is forwarded without editing this method.
    const cfg: AgentConfig = {
      ...t,
      tools: t.tools.slice(),
    };
    // Always set a stable id so SessionManager can locate snapshots after
    // the in-memory agent cache is cleared (stateless resume / restart).
    cfg.id = t.id ?? this.name;

    // The caller's per-thread config goes on last of the template-derived
    // values, so it can supply what the template cannot carry and override
    // what it can. See StrandsAgentConfig.threadAgentConfig.
    if (callerConfig) Object.assign(cfg, callerConfig);

    // Re-asserted after the caller: these are what keeps threads apart and a
    // run coherent, so they stay the adapter's to set.
    cfg.printer = false;
    // Assigned or removed, never left alone. Overwriting only when there is a
    // replacement to hand would make the guarantee conditional on the adapter
    // happening to have one: with no session-manager provider and a cold
    // thread, a caller value would survive and every thread would share one
    // session and one history.
    if (sessionManager) cfg.sessionManager = sessionManager;
    else delete cfg.sessionManager;
    if (seedMessages && seedMessages.length > 0) cfg.messages = seedMessages;
    else delete cfg.messages;
    // Only forward plugins when the caller supplied them explicitly. Passing
    // `plugins: []` risks being interpreted by a future SDK as "disable
    // default plugins".
    if (this._plugins.length > 0) cfg.plugins = [...this._plugins];
    return cfg;
  }
}

// ---------- TypeScript-only helpers (no Python equivalent) ----------

/**
 * Async mutex modelled on Python's `asyncio.Lock`. Serializes first-time
 * thread initialization so concurrent requests for the same new threadId
 * don't both construct a per-thread agent.
 */
class AsyncMutex {
  private _tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this._tail;
    this._tail = next;
    await previous;
    return release;
  }
}

function _runStarted(input: RunAgentInput): BaseEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  };
}

/**
 * A terminal failure, optionally carrying the usage the run had already
 * accumulated.
 *
 * The counts are real spend whatever the run went on to do with them, so a
 * failure after one or more model calls reports what it used. `usage` is passed
 * only by the sites a model call can precede; everywhere else the default
 * leaves the field off, which is what tells a consumer nothing was measured
 * rather than that nothing was spent.
 */
function _runError(
  message: string,
  code: string,
  usage: TokenUsage[] = [],
): BaseEvent {
  return {
    type: EventType.RUN_ERROR,
    message,
    code,
    ..._runUsage(usage),
  };
}

/**
 * The `usage` field for a terminal event, or nothing at all.
 *
 * Aggregated per `(provider, model)` through the published shared helper rather
 * than a local sum, so every AG-UI producer groups identically. An empty result
 * omits the field: `[]` and a zeroed entry both read as a measured zero, and
 * "not measured" has to stay distinguishable from "measured as nothing".
 */
function _runUsage(entries: TokenUsage[]): { usage?: TokenUsage[] } {
  const aggregated = aggregateTokenUsage(entries);
  return aggregated.length > 0 ? { usage: aggregated } : {};
}

/**
 * Remove the assistant turn `AfterToolsEvent.endTurn` appended for a frontend
 * halt, identified by the exact content the adapter asked for so no other
 * message can be mistaken for it.
 */
function _dropFrontendHaltTurn(agent: unknown): void {
  const messages = (agent as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const last = messages[messages.length - 1] as {
    role?: unknown;
    content?: unknown;
  };
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
  if (last.content.length !== 1) return;
  if (
    (last.content[0] as { text?: unknown })?.text !== FRONTEND_HALT_TURN_TEXT
  ) {
    return;
  }
  messages.pop();
}

/**
 * Abandon a checkpoint this run has just refused to advertise.
 *
 * Rule 4 leaves an ACTIVATED checkpoint alone precisely because it holds parked
 * tool execution a resume would finish. That reasoning does not reach here: this
 * checkpoint was never advertised and never can be, so no client knows an
 * interrupt id to resume it with. Left activated it wedges the thread for good,
 * turning every later plain run into `PENDING_INTERRUPTS` and every resume into
 * `UNKNOWN_INTERRUPT_ID`. The run still fails loudly with its own code, so the
 * caller learns the turn was lost rather than silently succeeding.
 */
function _abandonUnadvertisedCheckpoint(agent: unknown): void {
  const state = (agent as { _interruptState?: { deactivate?: unknown } })
    ?._interruptState;
  if (typeof state?.deactivate === "function") {
    (state as { deactivate: () => void }).deactivate();
  }
}

/** True when the agent is parked on an activated Strands checkpoint. */
function _hasActiveInterrupt(agent: unknown): boolean {
  return (
    (agent as { _interruptState?: { activated?: unknown } })?._interruptState
      ?.activated === true
  );
}

/** One client answer as the continuation decision reads it. */
interface ContinuationResult {
  toolCallId: string;
  text: string;
  isError: boolean;
}

/**
 * What a continuation turn does, as a single value.
 *
 * Four mutually exclusive actions, so the body acts on one decision instead of
 * re-deriving it from a handful of booleans that can disagree with each other.
 */
type ContinuationPlan =
  | { kind: "fail-unnameable"; toolCallIds: string[] }
  | { kind: "replay-history" }
  | { kind: "reconcile" }
  | { kind: "prompt" };

/** Everything the decision reads. Nothing here has been mutated yet. */
interface ContinuationInputs {
  /**
   * Tool results the run would have to SAY and cannot name: the trailing ones
   * the prompt derivation could not resolve, plus any the carry-over prompt
   * would have to phrase.
   */
  unnameableResultIds: readonly string[];
  /**
   * True when this run can replace Strands' history wholesale and stream from
   * it. That needs the replay to be enabled, non-empty, and able to carry every
   * client answer this turn is answering: a replay that drops one installs the
   * question alone and discards the prompt that could have said what came back.
   */
  canReplayHistory: boolean;
  /** Reading the admission store failed, so nothing may be admitted. */
  setupFailed: boolean;
  /** The session manager and agent expose what reconciliation writes through. */
  canReconcile: boolean;
  /** Every frontend result this turn carries. */
  frontendResults: readonly ContinuationResult[];
  /** Those whose call id this adapter recorded at emission. */
  admittedIds: ReadonlySet<string>;
  /** How many exact proxy placeholders an activated checkpoint parks. */
  parkedPlaceholderCount: number;
  resumeSubmitted: boolean;
}

/**
 * Decide what a continuation turn does, before anything is written.
 *
 * Pure, and taken in one place, because every input below interacts with the
 * others: which prompt goes out decides whether an unnameable result is fatal,
 * and whether the turn is repairable at all decides whether a prompt goes out.
 * Ordering them as separate gates strung through a long body lets them be moved
 * independently until they contradict one another.
 */
function planContinuation(input: ContinuationInputs): ContinuationPlan {
  // A result nobody can name is fatal on every path, as it is in the Python
  // sibling. Saying what came back needs the name, and guessing feeds the model
  // false context. Replayed history looks exempt, because there the result rides
  // its own `toolResult` block addressed by id, but the two conditions arrive
  // together: nothing can name the call precisely BECAUSE the assistant
  // `toolUse` block is absent from the payload, so the replay would install a
  // `toolResult` no `toolUse` answers and real providers reject that history.
  // Exempting it trades a designed error for a generic provider failure.
  //
  // Decided before any write, so a run that fails closed leaves the turn as
  // repairable as it found it and the retry keeps its admission signal.
  if (input.unnameableResultIds.length > 0) {
    return {
      kind: "fail-unnameable",
      toolCallIds: [...input.unnameableResultIds],
    };
  }
  if (input.canReplayHistory) return { kind: "replay-history" };

  // Repairing a turn needs a placeholder to repair, and only an admitted call
  // has one this adapter may rewrite. Every result that SAYS something -- a
  // body, or a failure -- therefore has to be admitted for the turn to be
  // repairable at all: correcting the admitted half alone leaves the other
  // half's stub standing as the client's answer while the store reads as
  // reconciled. The whole turn goes through the continuation prompt instead,
  // which phrases every result of a turn nothing was corrected for. No
  // pre-write reading says which corrections will land, so the caller handles
  // the post-write equivalent by taking the corrected answers back out of the
  // prompt.
  //
  // A failure counts even with an empty body: its status is the whole answer,
  // and leaving it uncorrected reports a tool the human denied as a success.
  //
  // Counted over DISTINCT call ids. A payload repeating one id carries one
  // answer, not two, and comparing a repeated count against the de-duplicated
  // admission set makes a fully-admitted turn look unrepairable forever.
  const mustRepair = new Set<string>();
  for (const result of input.frontendResults) {
    if (result.text.trim().length === 0 && !result.isError) continue;
    mustRepair.add(result.toolCallId);
  }
  const unrepairable = [...mustRepair].some((id) => !input.admittedIds.has(id));

  // An admitted VOID result still reconciles. Its stub is this adapter's own
  // persisted write, so leaving it means the store asserts "Forwarded to
  // client" as the client's answer forever and the call id is never pruned. The
  // reconciler answers a void result with a synthetic acknowledgement, which is
  // what the model should read in the stub's place.
  const anythingToRepair =
    input.admittedIds.size > 0 || input.parkedPlaceholderCount > 0;

  // A resume is exempt from the all-or-nothing rule: the gate before this has
  // already proved every parked placeholder has a mapped client result, and the
  // resume path never swaps in the continuation prompt, so correcting its
  // checkpoint cannot double-tell the model anything.
  if (
    !input.setupFailed &&
    input.canReconcile &&
    anythingToRepair &&
    (!unrepairable || input.resumeSubmitted)
  ) {
    return { kind: "reconcile" };
  }
  return { kind: "prompt" };
}

function _continuationToolNameError(toolCallIds: string[]): BaseEvent {
  return _runError(
    "Cannot name the tool behind continuation tool result(s) " +
      `${toolCallIds.join(", ")}: absent from the input messages and ` +
      "from the native session history",
    "CONTINUATION_TOOL_NAME_UNRESOLVED",
  );
}

function _interruptReconciliationError(usage: TokenUsage[] = []): BaseEvent {
  return _runError(
    "Active interrupt tool result reconciliation failed",
    "INTERRUPT_RECONCILIATION_ERROR",
    usage,
  );
}

function _interruptSessionRequiredError(usage: TokenUsage[] = []): BaseEvent {
  return _runError(
    "A SessionManager is required for a mixed frontend-proxy/native " +
      "interrupt checkpoint",
    "INTERRUPT_SESSION_REQUIRED",
    usage,
  );
}

function _interruptSessionCapabilityError(usage: TokenUsage[] = []): BaseEvent {
  return _runError(
    "Mixed frontend-proxy/native interrupt state requires a session manager " +
      "exposing saveSnapshot() and an agent exposing messages",
    "INTERRUPT_SESSION_CAPABILITY_ERROR",
    usage,
  );
}

/**
 * Validate a resolved resume payload against an object response schema, or
 * `null` when it satisfies the schema (or the schema is not an object schema).
 */
function validateResumePayload(
  entry: ResumeEntry,
  schema: Record<string, unknown>,
): BaseEvent | null {
  if (schema.type !== "object") return null;
  if (typeof entry.payload !== "object" || entry.payload == null) {
    return _runError(
      `Invalid payload for interrupt '${entry.interruptId}': expected an object.`,
      "INVALID_PAYLOAD",
    );
  }
  const payload = entry.payload as Record<string, unknown>;
  const required = schema.required as string[] | undefined;
  if (Array.isArray(required)) {
    const missingKeys = required.filter((k) => !(k in payload));
    if (missingKeys.length > 0) {
      return _runError(
        `Invalid payload for interrupt '${entry.interruptId}': ` +
          `missing required keys: ${missingKeys.join(", ")}.`,
        "INVALID_PAYLOAD",
      );
    }
  }
  const typeError = validateObjectPayloadPropertyTypes(schema, payload);
  if (typeError) {
    return _runError(
      `Invalid payload for interrupt '${entry.interruptId}': ${typeError}`,
      "INVALID_PAYLOAD",
    );
  }
  return null;
}

/** Non-empty `resume[]` entries, or `[]` if missing. */
function resolveResumeEntries(input: RunAgentInput): ResumeEntry[] {
  const resume = (input as { resume?: ResumeEntry[] }).resume;
  return Array.isArray(resume) && resume.length > 0 ? resume : [];
}

/**
 * AG-UI `ResumeEntry` → Strands `InterruptResponseContent.response`.
 *
 * One contract with the Python adapter, so a tool body ports between them: a
 * generic interrupt is answered with an envelope, `{ response: payload }` on
 * resolve and {@link INTERRUPT_CANCELLED} on cancel, and unwraps via
 * `.response` / `.cancelled`.
 *
 * The envelope is also what makes a falsy answer answerable. Strands reads a
 * recorded answer either by presence (`response !== undefined`) or, on the
 * oldest releases the Python adapter still supports, by truthiness, and an
 * answer it reads as absent re-raises the same interrupt and re-runs the tool
 * body forever. An envelope is always present and always truthy. An absent
 * payload becomes `null` inside it rather than being dropped, so the recorded
 * answer survives the JSON round trip through session persistence unchanged.
 *
 * Tool approvals are the exception in both languages: the approval hook reads
 * `approved` off the answer directly, so a resolved approval's payload is passed
 * through raw and anything else is spelled as the denial the hook expects. Rule 6
 * schema-checks a resolved approval's payload before it reaches here.
 *
 * `nativeInterrupt` is required rather than optional: it is the whole
 * discriminator, and omitting it would silently answer an approval with the
 * envelope, which its hook reads as a denial.
 */
function toResumeResponse(
  entry: ResumeEntry,
  nativeInterrupt: unknown,
): unknown {
  if (isToolApprovalInterrupt(nativeInterrupt)) {
    // Only a resolved entry can grant. Rule 6 schema-checks the payload of a
    // resolved approval before it reaches here, and nothing else is a grant, so
    // an unrecognised status denies rather than forwarding an unchecked answer.
    return entry.status === "resolved"
      ? (entry.payload as unknown)
      : { approved: false };
  }
  if (entry.status === "cancelled") return { ...INTERRUPT_CANCELLED };
  return { response: entry.payload === undefined ? null : entry.payload };
}

// ---------------------------------------------------------------------------
// Interrupt bookkeeping persistence
// ---------------------------------------------------------------------------
//
// `_pendingInterruptsByThread` and `_lastResumeFingerprint` are the
// adapter's own bookkeeping (idempotency fingerprint + AG-UI-specific
// interrupt metadata like responseSchema/expiresAt) layered on top of
// Strands' native `_interruptState`. Strands' own SessionManager already
// persists/restores `_interruptState`, but this adapter-only bookkeeping
// lived purely in an in-process Map, so a process restart lost it: rules
// 6/7 (payload-schema validation, expiresAt enforcement) would silently
// degrade, and a replayed resume request would no longer be recognized as
// a duplicate and could re-invoke the model/tool.
//
// To survive a restart, this bookkeeping is now mirrored into
// `strandsAgent.appState` under a single namespaced key — the same
// per-thread, SessionManager-persisted key-value store available on every
// Strands `Agent`. On every read, if nothing is cached in-process for this
// threadId, fall back to what's persisted in appState.

const INTERRUPT_BOOKKEEPING_STATE_KEY = "ag_ui_interrupt_bookkeeping";

interface PersistedInterruptBookkeeping {
  lastResumeFingerprint: string | null;
  pendingInterrupts: Record<string, unknown>;
}

/**
 * Read the persisted (fingerprint, pending-interrupts) pair from
 * `strandsAgent.appState`, if present and well-formed.
 *
 * Defensive by design: a test double (e.g. a bare stub standing in for the
 * Strands agent) may not have a real `appState`, or `appState.get(...)`
 * could return something unexpected — every layer of the expected shape is
 * checked explicitly before trusting it. Anything that doesn't match is
 * treated as "nothing persisted" rather than thrown.
 */
function loadPersistedInterruptBookkeeping(strandsAgent: unknown): {
  pending: Map<string, AguiInterrupt> | null;
  fingerprint: string | null;
} {
  try {
    const appState = (strandsAgent as { appState?: unknown })?.appState as
      | { get?: (key: string) => unknown }
      | undefined;
    if (!appState || typeof appState.get !== "function") {
      return { pending: null, fingerprint: null };
    }
    const raw = appState.get(INTERRUPT_BOOKKEEPING_STATE_KEY);
    if (!raw || typeof raw !== "object") {
      return { pending: null, fingerprint: null };
    }
    const data = raw as Partial<PersistedInterruptBookkeeping>;

    const fingerprint =
      typeof data.lastResumeFingerprint === "string"
        ? data.lastResumeFingerprint
        : null;

    let pending: Map<string, AguiInterrupt> | null = null;
    if (data.pendingInterrupts && typeof data.pendingInterrupts === "object") {
      pending = new Map();
      for (const [id, value] of Object.entries(data.pendingInterrupts)) {
        const parsed = AguiInterruptSchema.safeParse(value);
        if (parsed.success) {
          pending.set(id, parsed.data);
        }
      }
    }
    return { pending, fingerprint };
  } catch {
    return { pending: null, fingerprint: null };
  }
}

/**
 * Write the (fingerprint, pending-interrupts) pair to `strandsAgent.appState`
 * so it survives a process restart via whatever SessionManager is wired up.
 * Best-effort: a test double without a real `appState.set(...)` must never
 * break the run over bookkeeping that's a durability nice-to-have, not a
 * correctness requirement for the current process.
 */
function persistInterruptBookkeeping(
  strandsAgent: unknown,
  pending: Map<string, AguiInterrupt> | null,
  fingerprint: string | null,
  log?: Logger,
): void {
  try {
    const appState = (strandsAgent as { appState?: unknown })?.appState as
      | { set?: (key: string, value: unknown) => void }
      | undefined;
    if (!appState || typeof appState.set !== "function") {
      return;
    }
    const pendingInterrupts: Record<string, unknown> = {};
    if (pending) {
      for (const [id, interrupt] of pending) {
        pendingInterrupts[id] = interrupt;
      }
    }
    const payload: PersistedInterruptBookkeeping = {
      lastResumeFingerprint: fingerprint,
      pendingInterrupts,
    };
    appState.set(INTERRUPT_BOOKKEEPING_STATE_KEY, payload);
  } catch (e) {
    log?.warn(
      `${LOG_PREFIX} Failed to persist interrupt bookkeeping to strandsAgent.appState: ${_errorMessage(e)}`,
    );
  }
}

/** Strands `Interrupt` → AG-UI `Interrupt`. */
function strandsInterruptToAgui(
  interrupt: StrandsInterrupt,
  log?: Logger,
): AguiInterrupt {
  const reasonRaw = interrupt.reason;
  // Only interrupts raised by our own interruptOnCall hook (identified by
  // the "ag_ui:tool_call:" name prefix it always uses) are tool-call
  // approvals with the {tool_call, tool_name, tool_input, tool_use_id}
  // reason shape. Any other interrupt — e.g. one a user's own tool or hook
  // raises directly via event.interrupt() for a generic human-in-the-loop
  // purpose — must stay generic: preserve its native name/reason payload
  // rather than guessing tool-approval semantics out of an unrelated
  // object.
  if (!isToolApprovalInterrupt(interrupt)) {
    const out: AguiInterrupt = {
      id: interrupt.id,
      reason: interrupt.name ?? "interrupt",
    };
    if (reasonRaw !== undefined && reasonRaw !== null) {
      out.metadata = { reason: reasonRaw };
    }
    return out;
  }

  // An approval carries the same keys on both bridges, so a client renders one
  // the same way whichever language served it: a message, the response schema,
  // and tool_name / tool_input / strandsName in metadata are always present,
  // standing in the same defaults as the Python adapter. Two keys are
  // conditional: toolCallId, which an approval raised without a native tool use
  // has none of, and reason, added below only when nothing else carried it.
  const { toolName, toolInput } = approvalReasonFields(reasonRaw, log);
  const out: AguiInterrupt = {
    id: interrupt.id,
    reason: "tool_call",
    message: `Approve call to ${toolName}?`,
    responseSchema: toolApprovalResponseSchema(),
    metadata: {
      tool_name: toolName,
      tool_input: toolInput,
      strandsName: interrupt.name,
    },
  };
  // Reported only when it is a usable string, matching the Python adapter,
  // whose `Interrupt.tool_call_id` rejects anything else outright.
  const toolUseId = plainObject(reasonRaw).tool_use_id;
  if (typeof toolUseId === "string" && toolUseId) out.toolCallId = toolUseId;
  // An approval whose reason carried nothing the three keys above could hold
  // still publishes that reason, rather than reaching the client as nothing but
  // the defaults. The test is what was actually extracted, not whether the
  // reason was empty: a mapping like `{ question: "..." }` has keys and is still
  // entirely unrepresented by tool_name / tool_input / toolCallId. Detached like
  // everything else published, since a reason can be an array or a nested object.
  const carriedNothing =
    toolName === "unknown" &&
    Object.keys(toolInput).length === 0 &&
    out.toolCallId === undefined;
  if (reasonRaw !== undefined && reasonRaw !== null && carriedNothing) {
    (out.metadata as Record<string, unknown>).reason = detachedValue(
      reasonRaw,
      log,
    );
  }
  return out;
}

/** `value` as a plain object, or an empty one. */
function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A detached copy of any JSON-shaped value, at every depth.
 *
 * The object form below is the common case; this one also takes an array, a
 * string or a number, which is what an unusable interrupt reason can be.
 */
function detachedValue(value: unknown, log?: Logger): unknown {
  try {
    return structuredClone(value);
  } catch (e) {
    // Saying so matters: the caller published this expecting a copy, and what
    // it actually got is a handle on the live interrupt reason. Inside its own
    // `try` because a caller-supplied logger is arbitrary code that can throw,
    // and a throw escaping here would turn a successfully raised interrupt into
    // a run error.
    try {
      log?.warn(
        `${LOG_PREFIX} could not detach an interrupt reason for publication; it is shared with the live checkpoint: ${_errorMessage(e)}`,
      );
    } catch {
      // Nothing to do: the value below is still returned either way.
    }
    return value;
  }
}

/**
 * A detached copy of JSON-shaped data, at every depth.
 *
 * A shallow copy is not enough for anything published to a client: the nested
 * values would still be handles on the live native interrupt's reason. Falls
 * back to a shallow copy for the rare reason carrying something unclonable,
 * which is still better than aliasing the whole object.
 */
function detachedCopy(
  value: Record<string, unknown>,
  log?: Logger,
): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch (e) {
    // A shallow copy still leaves the nested values shared, so this is a
    // degraded result and not the guarantee the caller asked for. Logged inside
    // its own `try` for the same reason as above.
    try {
      log?.warn(
        `${LOG_PREFIX} could not fully detach a tool input for publication; its nested values are shared with the live checkpoint: ${_errorMessage(e)}`,
      );
    } catch {
      // Nothing to do: the copy below is still returned either way.
    }
    return { ...value };
  }
}

/**
 * The tool identity an approval publishes, read out of its native reason.
 *
 * The reason can be missing or malformed, most plausibly because it did not
 * survive a restart, so both fields fall back. The same defaults and the same
 * "is it usable?" tests as the Python adapter, so an approval published from
 * either language reads identically.
 */
function approvalReasonFields(
  reasonRaw: unknown,
  log?: Logger,
): {
  toolName: string;
  toolInput: Record<string, unknown>;
} {
  const reason = plainObject(reasonRaw);
  const name = reason.tool_name;
  return {
    toolName: typeof name === "string" && name ? name : "unknown",
    // Detached at every depth, not merely copied at the top: the published
    // metadata must not be a handle on the live native interrupt's reason at
    // ANY level. Same guarantee in Python.
    toolInput: detachedCopy(plainObject(reason.tool_input), log),
  };
}

function getEventKind(event: unknown): string | undefined {
  if (event && typeof event === "object" && "type" in event) {
    const t = (event as { type: unknown }).type;
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

/**
 * True if `event` is a `ContentBlockEvent` — an assembled content block.
 *
 * `Agent.stream()` yields one of these for EVERY completed content block: any
 * value from `model.streamAggregated` that is not a `ModelStreamEvent` gets
 * wrapped as `new ContentBlockEvent({ contentBlock })`. A content block is by
 * construction the assembled form of deltas the adapter has *already* streamed
 * — `textBlock` is the finished text of a turn that went out chunk by chunk as
 * `TEXT_MESSAGE_CONTENT`, `reasoningBlock` the finished reasoning that went out
 * as `REASONING_MESSAGE_CONTENT`.
 *
 * The dispatch chain translates only `toolUseBlock`, so with a terminal RAW
 * fallback in place every other block kind would fall through and re-deliver
 * the whole assistant message a second time, immediately after it streamed.
 * That is the same duplication the Python adapter's explicit
 * `ModelMessageEvent` skip prevents.
 *
 * Tested against the real `ContentBlockEvent` / `TextBlock` / `ReasoningBlock`
 * classes rather than object literals — see `raw-content-block.test.ts`.
 *
 * Must be evaluated before `unwrapStrandsEvent`, which discards the wrapper.
 */
function isAssembledContentBlock(event: unknown): boolean {
  return getEventKind(event) === "contentBlockEvent";
}

/**
 * Unwrap wrapper hook events the Strands v1 SDK uses to decorate raw model,
 * content-block, and tool-stream events:
 *   `ModelStreamUpdateEvent → .event`
 *   `ContentBlockEvent → .contentBlock`
 *   `ToolStreamUpdateEvent → .event` (inner `ToolStreamEvent` carries
 *     the per-yield payload a tool's async generator produces)
 * Anything else passes through.
 */
function unwrapStrandsEvent(event: unknown): unknown {
  if (!event || typeof event !== "object") return event;
  const kind = (event as { type?: unknown }).type;
  if (kind === "modelStreamUpdateEvent" && "event" in event) {
    return (event as { event: unknown }).event;
  }
  if (kind === "toolStreamUpdateEvent" && "event" in event) {
    return (event as { event: unknown }).event;
  }
  if (kind === "contentBlockEvent" && "contentBlock" in event) {
    return (event as { contentBlock: unknown }).contentBlock;
  }
  return event;
}

/**
 * Transform explicit START/CONTENT/END triples into self-expanding chunk
 * equivalents, driven by `StrandsAgentConfig.emitChunkEvents`.
 *
 * Per `concepts/events.mdx` (TextMessageChunk):
 * - First chunk carries `messageId` (+ optional `role`) — the client
 *   transformer auto-emits `TEXT_MESSAGE_START`.
 * - Each chunk with a `delta` auto-emits `TEXT_MESSAGE_CONTENT`.
 * - `TEXT_MESSAGE_END` is auto-emitted by the client transformer when
 *   ids change or the stream ends, so we drop our explicit END event, but not
 *   its metadata: that rides a final metadata-only chunk, which is how a
 *   trailing citation survives this mode.
 *
 * Same pattern for `TOOL_CALL_*` and `REASONING_MESSAGE_*`.
 */
async function* collapseToChunkEvents(
  source: AsyncGenerator<BaseEvent, void, void>,
): AsyncGenerator<BaseEvent, void, void> {
  for await (const event of source) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START: {
        const e = event as { messageId?: string; role?: string };
        yield {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: e.messageId,
          role: e.role,
          ...(event.metadata !== undefined && { metadata: event.metadata }),
        } as BaseEvent;
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const e = event as { messageId?: string; delta?: string };
        yield {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: e.messageId,
          delta: e.delta,
          // Rebuilding the event drops anything not copied across, and metadata
          // merges into the message rather than describing the envelope, so it
          // has to travel. The dropped END below is why a citation arriving
          // after the last text delta only reaches a chunk-mode client through
          // the MESSAGES_SNAPSHOT.
          ...(event.metadata !== undefined && { metadata: event.metadata }),
        } as BaseEvent;
        break;
      }
      case EventType.TEXT_MESSAGE_END: {
        // The END itself is dropped: the client transformer closes the message
        // on its own. Its metadata is not, because a citation that arrives
        // after the last text delta rides only this event, and the message
        // snapshot is not always there to carry it: the multi-agent
        // orchestrator path emits none at all.
        //
        // A continuation chunk carrying only metadata is the transform's own
        // route for this. It synthesizes no START and no delta, and turns into
        // a zero-delta content event so the value still reaches the reducer.
        const e = event as { messageId?: string };
        if (event.metadata !== undefined && e.messageId !== undefined) {
          yield {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: e.messageId,
            metadata: event.metadata,
          } as BaseEvent;
        }
        break;
      }
      case EventType.TOOL_CALL_START: {
        const e = event as {
          toolCallId?: string;
          toolCallName?: string;
          parentMessageId?: string;
        };
        yield {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: e.toolCallId,
          toolCallName: e.toolCallName,
          parentMessageId: e.parentMessageId,
        } as BaseEvent;
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const e = event as { toolCallId?: string; delta?: string };
        yield {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: e.toolCallId,
          delta: e.delta,
        } as BaseEvent;
        break;
      }
      case EventType.TOOL_CALL_END:
        break;
      case EventType.REASONING_MESSAGE_START: {
        const e = event as { messageId?: string };
        yield {
          type: EventType.REASONING_MESSAGE_CHUNK,
          messageId: e.messageId,
        } as BaseEvent;
        break;
      }
      case EventType.REASONING_MESSAGE_CONTENT: {
        const e = event as { messageId?: string; delta?: string };
        yield {
          type: EventType.REASONING_MESSAGE_CHUNK,
          messageId: e.messageId,
          delta: e.delta,
        } as BaseEvent;
        break;
      }
      case EventType.REASONING_MESSAGE_END:
        break;
      default:
        yield event;
    }
  }
}

/**
 * Build the message-history seed handed to `AgentConfig.messages` on
 * cold-cache agent creation. TypeScript-only: the Python SDK mutates
 * `Agent.messages` in place after construction via
 * `_buildStrandsHistory`, whereas the TS SDK consumes a seed at
 * construction time.
 *
 * - Normal run (tail is a `user` turn): seed everything except the final
 *   user turn; the final turn is passed to `agent.stream(...)` as the
 *   fresh prompt.
 * - Continuation run (tail is a `tool` message) or orphan tail: seed the
 *   entire history so the agent sees its own tool call + result before the
 *   synthetic continuation prompt fires.
 *
 * Returns `undefined` when the resulting seed would be empty or would
 * start with an `assistant` turn (Bedrock rejects assistant-first history).
 */
export async function buildStrandsSeed(
  messages: AguiMessage[],
  log?: Logger,
  fetchOptions?: MediaConversionOptions,
): Promise<AgentConfig["messages"]> {
  if (messages.length === 0) return undefined;

  let sliceEnd = messages.length;
  const tail = messages[messages.length - 1];
  if (tail?.role === "user") sliceEnd = messages.length - 1;
  if (sliceEnd <= 0) return undefined;

  const seed = await convertMessagesForStrandsSeed(
    messages.slice(0, sliceEnd),
    log,
    fetchOptions,
  );
  if (seed.length === 0) return undefined;

  // Bedrock requires history to start with `user`; trim any leading
  // assistant turns (rare, e.g. bot-initiated UIs).
  while (seed.length > 0 && seed[0]?.role !== "user") seed.shift();
  if (seed.length === 0) return undefined;

  return seed as unknown as AgentConfig["messages"];
}

/**
 * Convert AG-UI messages into the `MessageData` shape `AgentConfig.messages`
 * accepts on cold-cache agent construction. Similar in spirit to
 * `_buildStrandsHistory` but drops orphan tool turns (Bedrock rejects them).
 */
export async function convertMessagesForStrandsSeed(
  messages: AguiMessage[],
  log?: Logger,
  fetchOptions?: MediaConversionOptions,
): Promise<Array<{ role: "user" | "assistant"; content: unknown[] }>> {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  let pendingToolCalls: Map<string, string> | null = null;
  let pendingToolResults: unknown[] | null = null;

  const flushToolResults = (): void => {
    if (pendingToolResults && pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
    }
    pendingToolResults = null;
    pendingToolCalls = null;
  };

  for (const msg of messages) {
    const role = msg.role;
    if (role === "system" || role === "developer") continue;

    if (role === "assistant") {
      flushToolResults();
      const toolCalls = (
        msg as {
          toolCalls?: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        }
      ).toolCalls;
      const content: unknown[] = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        content.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Assistant-side multimodal history is rare — preserve text only.
        for (const c of msg.content) {
          // Same three shapes `flattenContentToText` accepts, and no others:
          // copying `text` off anything carrying the key sent a tool result's
          // payload to the model as if the user had typed it.
          const typed = c as { type?: unknown; text?: unknown };
          const carriesText =
            typed?.type === undefined ||
            typed?.type === "text" ||
            typed?.type === "textBlock";
          if (
            carriesText &&
            typeof typed?.text === "string" &&
            typed.text.length > 0
          ) {
            content.push({ text: typed.text });
          }
        }
      }
      if (toolCalls && toolCalls.length > 0) {
        pendingToolCalls = new Map();
        for (const tc of toolCalls) {
          if (!tc?.id || !tc.function?.name) continue;
          let input: unknown = {};
          try {
            input = tc.function.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch (e) {
            log?.warn(
              `${LOG_PREFIX} seed tool args JSON parse failed for ${tc.function.name}; using raw string`,
              e,
            );
            input = tc.function.arguments ?? {};
          }
          content.push({
            toolUse: { name: tc.function.name, toolUseId: tc.id, input },
          });
          pendingToolCalls.set(tc.id, tc.function.name);
        }
      }
      if (content.length === 0) continue;
      out.push({ role: "assistant", content });
      continue;
    }

    if (role === "tool") {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      if (!toolCallId || !pendingToolCalls || !pendingToolCalls.has(toolCallId))
        continue;
      pendingToolResults ??= [];
      // Both halves from the producer the replay path and the reconciler use,
      // so status and content cannot disagree: deriving them separately seeds a
      // failure with an empty body as `status: "error"` beside a success
      // acknowledgement. On a cold start with the replay off this seed is the
      // whole of what the model reads.
      const { status, content } = clientResultFields(_clientResult(msg));
      pendingToolResults.push({
        toolResult: { toolUseId: toolCallId, status, content: [content] },
      });
      continue;
    }

    // role === "user"
    flushToolResults();
    const content: unknown[] = [];
    const rawUserContent = msg.content;
    if (typeof rawUserContent === "string") {
      if (rawUserContent.length > 0) content.push({ text: rawUserContent });
    } else if (Array.isArray(rawUserContent)) {
      const hasMedia = _contentHasMedia(rawUserContent);
      if (hasMedia) {
        try {
          const blocks = await convertAguiContentToStrands(
            rawUserContent as never,
            log,
            { ...fetchOptions, messageId: msg.id },
          );
          for (const b of blocks) {
            if (b instanceof TextBlock) {
              content.push({ text: b.text });
            } else {
              // Image/Video/Document `toJSON()` emits the wrapped
              // discriminated union the MessageData schema expects.
              const serialised =
                typeof (b as { toJSON?: () => unknown }).toJSON === "function"
                  ? (b as { toJSON: () => unknown }).toJSON()
                  : b;
              content.push(serialised);
            }
          }
        } catch (e) {
          (log ?? DEFAULT_LOGGER).warn(
            `${LOG_PREFIX} seed multimodal conversion failed; dropping attachments for this turn`,
            e,
          );
          const text = flattenContentToText(rawUserContent as never);
          if (text.length > 0) content.push({ text });
        }
      } else {
        for (const c of rawUserContent) {
          // Same three shapes `flattenContentToText` accepts, and no others:
          // copying `text` off anything carrying the key sent a tool result's
          // payload to the model as if the user had typed it.
          const typed = c as { type?: unknown; text?: unknown };
          const carriesText =
            typed?.type === undefined ||
            typed?.type === "text" ||
            typed?.type === "textBlock";
          if (
            carriesText &&
            typeof typed?.text === "string" &&
            typed.text.length > 0
          ) {
            content.push({ text: typed.text });
          }
        }
      }
    }
    // A user turn that yielded nothing still has to occupy its place: dropping
    // it leaves the assistant-first or consecutive-assistant history the
    // provider refuses, which is the same failure in a different shape. The
    // repair is the single space the document-only guard uses.
    if (content.length === 0) content.push({ text: " " });
    out.push({ role: "user", content });
  }

  flushToolResults();
  return out;
}

/** Recursively sort object keys for deterministic JSON serialization. */
function _sortKeys(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(_sortKeys);
  return Object.keys(val as Record<string, unknown>)
    .sort()
    .reduce(
      (acc, k) => {
        acc[k] = _sortKeys((val as Record<string, unknown>)[k]);
        return acc;
      },
      {} as Record<string, unknown>,
    );
}

/**
 * Canonicalize resume entries before hashing so a semantically identical
 * resume[] replay is recognized regardless of the client's entry ordering.
 */
function resumeFingerprint(entries: ResumeEntry[]): string {
  const canonicalEntries = entries
    .map((entry) =>
      // Omit the slot for a resolved entry without a payload rather than
      // serializing `undefined`, which JSON would collapse into null. The two
      // now submit the same answer, so keeping them distinct here means a
      // retry that varies only in that spelling misses the idempotency
      // short-circuit and is refused as having nothing open to address, rather
      // than answered as the replay it is. Left as it stands because collapsing
      // them changes idempotency behaviour, which is not this change's subject;
      // the parked-checkpoint path bypasses the fingerprint entirely and
      // compares submitted answers, so it already treats them as one. A
      // cancelled entry's payload never reaches the SDK, so its canonical form
      // is left alone.
      entry.status !== "cancelled" && entry.payload === undefined
        ? ([entry.interruptId, entry.status] as const)
        : ([
            entry.interruptId,
            entry.status,
            _sortKeys(entry.payload),
          ] as const),
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

  return createHash("md5")
    .update(JSON.stringify(canonicalEntries))
    .digest("hex");
}

/**
 * Deliberately small JSON Schema validator for object-property primitive
 * types. Required-field validation is handled by the caller; this only
 * validates fields that the client supplied. It keeps the adapter dependency
 * free while ensuring an approval schema rejects e.g. { approved: "true" }.
 */
function validateObjectPayloadPropertyTypes(
  schema: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return undefined;
  }

  for (const [field, fieldSchema] of Object.entries(
    properties as Record<string, unknown>,
  )) {
    if (
      !(field in payload) ||
      !fieldSchema ||
      typeof fieldSchema !== "object"
    ) {
      continue;
    }
    const type = (fieldSchema as { type?: unknown }).type;
    if (
      typeof type !== "string" ||
      jsonSchemaTypeMatches(payload[field], type)
    ) {
      continue;
    }
    return `field '${field}' must be ${jsonSchemaTypeDescription(type)}.`;
  }

  return undefined;
}

function jsonSchemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      // Unsupported JSON Schema constructs remain the caller's responsibility.
      return true;
  }
}

// JSON Schema type names that take "an". The Python bridge keys off the same
// set: the rendered message is a wire contract clients match literally.
const VOWEL_INITIAL_JSON_SCHEMA_TYPES = new Set(["array", "integer", "object"]);

function jsonSchemaTypeDescription(type: string): string {
  const article = VOWEL_INITIAL_JSON_SCHEMA_TYPES.has(type) ? "an" : "a";
  return `${article} ${type}`;
}
