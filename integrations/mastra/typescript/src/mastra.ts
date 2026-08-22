import type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  AgentConfig,
  BaseEvent,
  CustomEvent,
  Interrupt,
  Message,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunFinishedInterruptOutcome,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import {
  TokenUsage,
  aggregateTokenUsage,
  tokenUsageFromAiSdkUsage,
} from "@ag-ui/core";
import type { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { randomUUID } from "@ag-ui/client";
import jsonpatch from "fast-json-patch";
import { parsePartialJson } from "@ai-sdk/ui-utils";
import { Observable } from "rxjs";
import type { MastraClient } from "@mastra/client-js";
import {
  convertAGUIMessagesToMastra,
  GetLocalAgentsOptions,
  getLocalAgents,
  getRemoteAgents,
  GetRemoteAgentsOptions,
  GetLocalAgentOptions,
  getLocalAgent,
  GetNetworkOptions,
  getNetwork,
} from "./utils";
import { planA2UIInjection, type A2UIInjectConfig } from "./a2ui-tool";

const { compare } = jsonpatch;

type RemoteMastraAgent = ReturnType<MastraClient["getAgent"]>;

/**
 * AG-UI `activityType` used for Mastra Background Tasks. Background work
 * (a tool with `background: { enabled: true }`) runs out-of-band while the
 * agent conversation continues; the bridge surfaces its lifecycle as AG-UI
 * ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events so the UI can render it distinctly
 * from normal streamed responses. Renderers register against this string via
 * CopilotKit's `renderActivityMessages` prop.
 *
 * The activity `content` shape (one activity per Mastra task; `messageId` is
 * the Mastra `taskId`):
 *
 *   {
 *     taskId: string;        // Mastra background task id (== activity messageId)
 *     toolName: string;      // the backgrounded tool
 *     toolCallId: string;    // originating tool call
 *     status: "started" | "running" | "suspended" | "resumed"
 *           | "completed" | "failed" | "cancelled";
 *     args?: Record<string, unknown>;  // tool args, once running
 *     outputs: unknown[];    // streamed tool-output chunks, appended in order
 *     elapsedMs?: number;    // wall-clock since dispatch, ticked by progress
 *     result?: unknown;      // final result on completion
 *     error?: string;        // message on failure
 *     suspendPayload?: unknown; // data passed to suspend(), when suspended
 *     startedAt?: string;    // ISO timestamp
 *     completedAt?: string;  // ISO timestamp
 *   }
 *
 * This shape is a sensible default proposed by the AG-UI bridge; it is intended
 * to be co-designed with Mastra (see OSS-93) and may evolve.
 */
export const MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE = "mastra-background-task";

/**
 * Tool name(s) Mastra uses for the built-in working-memory update tool. When an
 * agent has working memory enabled, Mastra injects this tool; the model calls
 * it mid-run with the new working-memory content. The bridge maps those calls
 * to AG-UI STATE_DELTA (see createChunkProcessor). Mastra registers it under
 * the key `updateWorkingMemory` (the name that appears on the stream chunk;
 * `UPDATE_WORKING_MEMORY_TOOL_NAME` in @mastra/core) with tool id
 * `update-working-memory` — match both so the mapping is robust to either.
 */
const WORKING_MEMORY_TOOL_NAMES = new Set([
  "updateWorkingMemory",
  "update-working-memory",
]);

/**
 * Deep-merges a working-memory update onto the existing state, mirroring
 * @mastra/core's `deepMergeWorkingMemory` (the semantics schema/json working
 * memory applies to partial updates): nested objects recurse, arrays are
 * replaced wholesale, an explicit `null` deletes the key, scalars overwrite.
 * Replicated here so the bridge can compute the post-update state — and thus an
 * accurate RFC-6902 delta — synchronously, without a mid-stream memory re-read.
 */
function deepMergeWorkingMemory(
  existing: Record<string, any> | undefined,
  update: Record<string, any>,
): Record<string, any> {
  if (
    !update ||
    typeof update !== "object" ||
    Object.keys(update).length === 0
  ) {
    return existing && typeof existing === "object" ? { ...existing } : {};
  }
  if (!existing || typeof existing !== "object") {
    return update;
  }
  const result: Record<string, any> = { ...existing };
  for (const key of Object.keys(update)) {
    const updateValue = update[key];
    const existingValue = result[key];
    if (updateValue === null) {
      delete result[key];
    } else if (Array.isArray(updateValue)) {
      result[key] = updateValue;
    } else if (
      typeof updateValue === "object" &&
      updateValue !== null &&
      typeof existingValue === "object" &&
      existingValue !== null &&
      !Array.isArray(existingValue)
    ) {
      result[key] = deepMergeWorkingMemory(existingValue, updateValue);
    } else {
      result[key] = updateValue;
    }
  }
  return result;
}

/**
 * Parses the `memory` argument of an `updateWorkingMemory` tool call into a
 * plain object suitable for structured state diffing. The arg is a JSON string
 * for schema/json working memory (the state-rendering case). Returns `undefined`
 * for markdown-template working memory (non-JSON string) or any non-object
 * payload — the caller then skips STATE_DELTA and relies on the run-end
 * STATE_SNAPSHOT.
 */
function parseWorkingMemoryUpdate(
  args: Record<string, any> | undefined,
): Record<string, any> | undefined {
  const raw = args?.memory ?? args;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return undefined;
}

/**
 * Best-effort parse of the PARTIAL, still-streaming raw tool-input text of an
 * `updateWorkingMemory` call — the accumulated `tool-call-delta` fragments, e.g.
 * `{"memory":"{\"recipe\":{\"title\":\"Sp`. Uses `parsePartialJson` (repairs
 * truncated JSON) twice: once for the outer `{ memory }` envelope, then for the
 * inner `memory` payload (a nested JSON string for schema/json working memory).
 * Returns the parseable prefix as an object so the bridge can emit an
 * incremental STATE_DELTA as the model writes the update; `undefined` while the
 * text is not yet a usable object (or is markdown-template working memory).
 */
function parseStreamingWorkingMemoryUpdate(
  argsText: string,
): Record<string, any> | undefined {
  if (!argsText) return undefined;
  const outer = parsePartialJson(argsText);
  const outerVal = outer.value;
  if (!outerVal || typeof outerVal !== "object" || Array.isArray(outerVal)) {
    return undefined;
  }
  const mem = (outerVal as Record<string, any>).memory;
  if (mem == null) return undefined;
  if (typeof mem === "object" && !Array.isArray(mem)) {
    return mem as Record<string, any>;
  }
  if (typeof mem === "string") {
    const inner = parsePartialJson(mem);
    const innerVal = inner.value;
    if (innerVal && typeof innerVal === "object" && !Array.isArray(innerVal)) {
      return innerVal as Record<string, any>;
    }
  }
  return undefined;
}

// Shape of a remote resume response. Newer @mastra/client-js (>= the release
// that added agent suspend/resume) exposes `resumeStream` on the remote Agent
// resource; it returns a Response augmented with `processDataStream` — the same
// callback-based stream the remote `.stream()` path consumes. We type it
// structurally (not against the installed client-js) so the bridge compiles
// against older client-js builds that predate `resumeStream`; the capability is
// probed at runtime via `hasRemoteResume` before use.
type RemoteResumeResponse = {
  processDataStream?: (args: {
    onChunk: (chunk: any) => void | Promise<void>;
  }) => Promise<void>;
};

interface RemoteResumableAgent {
  resumeStream(
    resumeData: unknown,
    options: Record<string, unknown>,
  ): Promise<RemoteResumeResponse | null | undefined>;
}

/**
 * Walks `finish.payload.response.uiMessages` to pull the final assistant text
 * after Mastra's output processors have run.
 *
 * Returns `undefined` when:
 *   - `uiMessages` is absent (older Mastra, or a non-finish chunk),
 *   - no assistant message is present,
 *   - the assistant message contains no text parts (tool-only response),
 * so callers can fall back to the buffered raw text.
 *
 * Accepts both string content and array-of-parts content shapes (Mastra's
 * UIMessage tolerates either depending on how the agent assembled its
 * response).
 */
function extractLastAssistantText(uiMessages: unknown): string | undefined {
  if (!Array.isArray(uiMessages)) return undefined;
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const message = uiMessages[i];
    if (!message || (message as { role?: string }).role !== "assistant") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content.length > 0 ? content : undefined;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part: any): part is { type: "text"; text: string } =>
            part?.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("");
      return text.length > 0 ? text : undefined;
    }
    // Some UIMessage shapes expose pre-joined text via a `text` field.
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) return text;
    return undefined;
  }
  return undefined;
}

/**
 * AG-UI `activityType` used for Mastra Observational Memory (OM). OM is a
 * Mastra memory feature the developer enables on THEIR agent
 * (`new Memory({ options: { observationalMemory: true } })`). When enabled,
 * Mastra runs Observer/Reflector agents out of band that read the conversation,
 * compress it into observations, and activate them into the context window. OM
 * surfaces this background work on the agent's `fullStream` as typed
 * `data-om-*` chunks (see `@mastra/core/channels/om` + the `@mastra/memory` OM
 * processor). The bridge maps the substantive lifecycle of those chunks to
 * AG-UI ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events so the UI can render the
 * "agent is observing / reflecting / compressing memory" activity distinctly
 * from the streamed response. Renderers register against this string via
 * CopilotKit's `renderActivityMessages` prop.
 *
 * Surfacing is OPT-IN per agent (`MastraAgentConfig.observationalMemory`,
 * default OFF) — OM is the developer's own opt-in, so the bridge does not
 * announce it unless asked. With the toggle OFF the `data-om-*` chunks are
 * swallowed silently (they carry no assistant output), so an OM-enabled agent
 * still streams cleanly through the bridge and emits no activity.
 *
 * The activity `content` shape (one activity per OM cycle; `messageId` is the
 * Mastra `cycleId`). In the async path the buffering cycle and its activation
 * share one `cycleId`, so they advance a single activity
 * running -> completed -> activated:
 *
 *   {
 *     cycleId: string;        // Mastra OM cycle id (== activity messageId)
 *     operationType: "observation" | "reflection";
 *     phase: "observation" | "buffering" | "activation";
 *     status: "running" | "completed" | "failed" | "activated";
 *     threadId?: string;
 *     recordId?: string;
 *     observations?: string;  // the observation/reflection summary text
 *     currentTask?: string;       // task the Observer extracted
 *     suggestedResponse?: string; // suggestion the Observer extracted
 *     tokensToObserve?: number;   // observation/buffering: tokens in this batch
 *     tokensObserved?: number;    // observation: tokens observed
 *     bufferedTokens?: number;    // buffering: resulting tokens after compress
 *     observationTokens?: number; // resulting observation tokens
 *     tokensActivated?: number;   // activation: message tokens activated
 *     chunksActivated?: number;   // activation: buffered chunks activated
 *     messagesActivated?: number; // activation: messages observed via activation
 *     generationCount?: number;   // activation: reflection generation count
 *     triggeredBy?: "threshold" | "ttl" | "provider_change";
 *     durationMs?: number;
 *     startedAt?: string;     // ISO timestamp
 *     completedAt?: string;   // ISO timestamp
 *     error?: string;         // message on failure
 *   }
 *
 * This shape is a sensible default proposed by the AG-UI bridge; it mirrors the
 * background-task activity shape and may evolve alongside Mastra's OM data
 * parts (see OSS-92).
 */
export const MASTRA_OBSERVATIONAL_MEMORY_ACTIVITY_TYPE =
  "mastra-observational-memory";

/**
 * Mastra tracing options threaded into the underlying `agent.stream(...)` /
 * `agent.resumeStream(...)` call. Typed structurally (not against
 * `@mastra/core`) so the bridge compiles on any supported core in the peer
 * range — cores predating observability v-next simply ignore an unknown
 * `tracingOptions` key. Mirrors Mastra's `TracingOptions`:
 *   - `traceId`: a caller-chosen trace id to anchor the run under (lets a client
 *     self-assign a trace it already knows, e.g. to attach feedback later).
 *   - `metadata`: arbitrary key/values attached to the run's root trace span.
 */
export interface MastraTracingOptions {
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface MastraAgentConfig extends AgentConfig {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  requestContext?: RequestContext;
  /**
   * Forward Mastra tracing options into the run's `agent.stream(...)` (and the
   * resume path). Chiefly lets a caller inject a self-chosen `traceId` so the
   * Mastra execution trace is anchored to an id the client already knows,
   * enabling trace-centric feedback/scores (`createFeedback({ traceId })`).
   *
   * NOT per-run: this config (and any `traceId` in it) is stored once on the
   * agent instance and reused verbatim for EVERY run of that instance. So a
   * config-level `tracingOptions.traceId` is applied to every run, not to a
   * single run, meaning a caller who sets a fixed `traceId` here and reuses one
   * `MastraAgent` across many runs collapses all those runs onto a single trace.
   * Callers who want a distinct traceId per run should construct a fresh agent
   * per run (the `registerCopilotKit` / `getLocalAgents` path already does this,
   * since agents are constructed inside the per-request route handler).
   *
   * The OUTBOUND execution traceId surfaced on `RUN_FINISHED.result` IS per-run:
   * when no inbound `traceId` is set, Mastra generates one for that run, which
   * the bridge surfaces back to the client (see {@link makeRunFinishedEvent}).
   * Inert on cores that predate Mastra observability v-next.
   */
  tracingOptions?: MastraTracingOptions;
  /**
   * Opt into Mastra's `untilIdle` run mode (local agents only). When set, the
   * bridge passes `untilIdle` to `agent.stream(...)`, which subscribes to the
   * background-task manager for the run's memory scope and pipes the task
   * lifecycle chunks (`background-task-running` / `-output` / `-completed` /
   * `-failed` / …) into the SAME `fullStream`, re-entering the agentic loop so
   * the model reacts to the result in the same run. Without it, only
   * `background-task-started` reaches the run stream and completion is
   * delivered out of band. Requires a configured storage backend + a memory
   * scope (Mastra falls through to the default stream otherwise). `true` uses
   * Mastra's default idle timeout; pass `{ maxIdleMs }` to override.
   *
   * CAVEAT (verified against @mastra/core 1.47.0): in practice only
   * `background-task-started` + `-running` reach the piped stream;
   * `background-task-completed` does NOT arrive, so the run idles out without a
   * completion and the activity stays "running". Treat this as the forward-
   * looking hook for when Mastra delivers terminal lifecycle on the stream;
   * leave it OFF until then (its only effect today is an idle hold with no
   * completion payload).
   */
  untilIdle?: boolean | { maxIdleMs?: number };
  /**
   * Terminate interrupted runs with the AG-UI structured outcome
   * `RUN_FINISHED.outcome={ type: "interrupt", interrupts: [...] }`, mapping each
   * Mastra tool suspend to an `Interrupt`.
   *
   * Default **true** (opt-out). The structured outcome is the canonical AG-UI
   * interrupt path; clients on the canonical resume protocol drive resume via
   * `RunAgentInput.resume`, which the bridge consumes here.
   *
   * REQUIRES a CopilotKit client **>= 1.61.2** (the release that reads
   * `outcome:"interrupt"` and resumes via `RunAgentInput.resume`). On older
   * clients (<= 1.61.1, incl. 1.60.1/1.61.0) the client records the structured
   * interrupt but never addresses it on resume, stranding the run with
   * `Thread has N pending interrupt(s) not addressed by resume`. **If you target
   * a client below 1.61.2, set this to `false`** to fall back to the legacy
   * `on_interrupt`-only path. (The bridge can't detect the client version — the
   * CopilotKit client is the consumer app's dependency, not this package's —
   * so the floor is a documented requirement, not an enforced one.)
   *
   * Independent of the legacy `CUSTOM(name="on_interrupt")` event, which is
   * always emitted (backward compat). When on, BOTH the legacy event and the
   * structured outcome are emitted; when off, only the legacy event plus a plain
   * `RUN_FINISHED` — exactly as before this flag existed. Resume itself consumes
   * BOTH the legacy `forwardedProps.command.resume` and the standard
   * `RunAgentInput.resume` channels regardless of this flag.
   */
  emitInterruptOutcome?: boolean;
  /**
   * A2UI auto-injection config (local agents). When the runtime/middleware
   * forwards `injectA2UITool`, the bridge injects a backend-owned `generate_a2ui`
   * tool (recovery + subagent) per run so the developer wires nothing — the
   * easy-devex path. Set `injectA2UITool:false` here to force it off; set
   * `model`/`defaultCatalogId`/`guidelines`/`recovery` to customize. A `model` is
   * required for auto-inject unless one can be inferred from the wrapped agent.
   */
  a2ui?: A2UIInjectConfig;
  /**
   * For REMOTE agents only: the `MastraClient` used to reach the agent. When
   * set, the bridge syncs `input.state` into the remote server's working memory
   * (via `client.updateWorkingMemory`) before streaming, so a client-side edit
   * to shared state reaches a remote agent the same way it does a local one.
   * Set by `getRemoteAgents`; unused for local agents (which sync through their
   * own `Memory` instance).
   */
  remoteClient?: MastraClient;
  /**
   * When the configured agent uses `outputProcessors` that rewrite assistant
   * text (e.g. character-voice transforms, redaction, format normalization),
   * the processor-modified text is available only on the `finish` /
   * `step-finish` chunk's `payload.response.uiMessages` — surfaced upstream in
   * https://github.com/mastra-ai/mastra/pull/11549 to expose processor output
   * through streaming.
   *
   * Set to `true` to buffer intermediate `text-delta` chunks and emit only the
   * processor-modified text extracted from that boundary's `uiMessages`. When a
   * boundary has no usable `uiMessages` (older Mastra, or processors that did
   * not modify text), the buffered raw text is emitted on the terminal `finish`
   * as a fallback so no text is ever dropped.
   *
   * Default: `false` (current behavior — text-delta chunks stream to the client
   * in real time, processor rewrites are not surfaced).
   *
   * Trade-off: enabling this loses real-time text streaming — the final
   * assistant text appears at once after the agent's last step. Required when
   * downstream consumers (e.g. CopilotKit chat UI) must render the
   * post-processor text rather than the raw LLM output.
   *
   * Tracking: https://github.com/ag-ui-protocol/ag-ui/issues/1726
   */
  useProcessedFinalText?: boolean;
  /**
   * Surface Mastra Observational Memory (OM) background work as AG-UI activity
   * events (activityType `mastra-observational-memory`). Default OFF.
   *
   * OM is the developer's own opt-in (enabled on their Mastra `Memory`), so the
   * bridge stays silent about it unless explicitly asked. When `true`, the
   * bridge maps the OM lifecycle chunks Mastra streams on `fullStream`
   * (`data-om-observation-*`, `data-om-buffering-*`, `data-om-activation`) to
   * ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events. When `false`/unset, those chunks
   * are swallowed (no activity emitted) but the stream still flows cleanly.
   *
   * Note: this toggle does NOT enable OM — that is configured on the agent's
   * Memory. It only controls whether the bridge surfaces OM's activity.
   */
  observationalMemory?: boolean;
}

interface MastraAgentStreamOptions {
  /**
   * Called when Mastra announces the persisted message id for the upcoming
   * step (the `start` / `step-start` chunk's `messageId`). The bridge adopts
   * this id for the assistant message it streams, so the id the client sees
   * equals the id Mastra stores. Without this the bridge would mint its own
   * id, and re-sent history on the next turn would not match storage, causing
   * Mastra to persist the assistant message again (duplicate history).
   */
  onMessageId?: (messageId: string) => void;
  onTextPart?: (text: string) => void;
  onReasoningStart?: () => void;
  onReasoningPart?: (text: string) => void;
  onReasoningEnd?: () => void;
  onFinishMessagePart?: () => void;
  /** Emit TOOL_CALL_START. Fired once per tool call, before any args. */
  onToolCallStart?: (streamPart: {
    toolCallId: string;
    toolName: string;
  }) => void;
  /**
   * Emit a TOOL_CALL_ARGS delta. The bridge streams these incrementally as
   * Mastra emits `tool-call-delta` chunks (raw JSON-text fragments), or emits
   * a single full-args delta on the fall-back path (older @mastra/core that
   * only emits the final `tool-call` chunk).
   */
  onToolCallArgs?: (streamPart: {
    toolCallId: string;
    argsTextDelta: string;
  }) => void;
  /** Emit TOOL_CALL_END. Fired once per tool call, after all args. */
  onToolCallEnd?: (streamPart: { toolCallId: string }) => void;
  onToolResultPart?: (streamPart: { toolCallId: string; result: any }) => void;
  onError: (error: Error) => void;
  /**
   * Terminate the run with RUN_FINISHED. Receives the Mastra execution traceId
   * (Mastra observability v-next) when the consumed stream exposed one, so the
   * bridge can surface it on `RUN_FINISHED.result` (see makeRunFinishedEvent).
   * traceId is undefined on cores/streams that don't expose one.
   */
  onRunFinished?: (traceId?: string, usage?: TokenUsage[]) => Promise<void>;
  onToolSuspended: (payload: {
    toolCallId: string;
    toolName: string;
    suspendPayload: any;
    args: Record<string, any>;
    resumeSchema: string;
    // The runId Mastra associated with the suspended run, taken from the
    // suspend chunk. Mastra keys the suspended workflow snapshot by this id —
    // which is NOT necessarily the AG-UI RunAgentInput.runId — so resume must
    // round-trip THIS value back to `resumeStream({ runId })`. Optional so the
    // bridge can fall back to the AG-UI runId when a chunk omits it.
    runId?: string;
  }) => void;
  /**
   * Emit an ACTIVITY_SNAPSHOT for a background task (full initial content).
   * Called once per task, when the task starts.
   */
  onActivitySnapshot?: (snapshot: {
    messageId: string;
    activityType: string;
    content: Record<string, any>;
  }) => void;
  /**
   * Emit an ACTIVITY_DELTA for a background task (RFC 6902 JSON patch against
   * the prior snapshot/delta content). Called on each subsequent lifecycle
   * chunk (running, output, progress, completed, failed, cancelled, …).
   */
  onActivityDelta?: (delta: {
    messageId: string;
    activityType: string;
    patch: Array<Record<string, any>>;
  }) => void;
  /**
   * Emit a STATE_SNAPSHOT (full shared state). Emitted once per run as the FIRST
   * working-memory state event, to establish the base the client/runtime patch
   * against — the AG-UI runtime applies STATE_DELTA from an empty document at
   * run start, so a leading snapshot is required or the first delta's paths are
   * unresolvable. Subsequent changes ride STATE_DELTA.
   */
  onStateSnapshot?: (snapshot: Record<string, any>) => void;
  /**
   * Emit a STATE_DELTA (RFC 6902 JSON patch) when the agent updates its working
   * memory mid-run. Emitted for every working-memory change AFTER the initial
   * snapshot, with the patch from the previously-known state to the post-update
   * state, so shared state renders live as it changes (the run-end
   * STATE_SNAPSHOT still follows).
   */
  onStateDelta?: (delta: Array<Record<string, any>>) => void;
}

export class MastraAgent extends AbstractAgent {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  requestContext?: RequestContext;
  untilIdle?: boolean | { maxIdleMs?: number };
  observationalMemory?: boolean;
  tracingOptions?: MastraTracingOptions;
  public headers?: Record<string, string>;
  /** See MastraAgentConfig.emitInterruptOutcome. Default true. */
  emitInterruptOutcome: boolean;
  /** See MastraAgentConfig.a2ui — A2UI auto-injection config. */
  a2ui?: A2UIInjectConfig;
  /** See MastraAgentConfig.remoteClient. Set for remote agents only. */
  remoteClient?: MastraClient;
  /** See MastraAgentConfig.useProcessedFinalText. Default false. */
  useProcessedFinalText: boolean;

  /**
   * Suffix appended to a turn's base (Mastra-stored) messageId to key the
   * SEPARATE AG-UI message that carries assistant text streamed AFTER a tool
   * call in the same turn. See {@link continuationMessageId} and the ordering
   * note in {@link makeStreamCallbacks}.
   */
  private static readonly ASSISTANT_TEXT_CONTINUATION_SUFFIX = "-agui-text";

  /**
   * Deterministic id for the "trailing text" continuation message split off a
   * turn whose tool call already rendered under `baseId`. Deterministic (a pure
   * function of the stored turn id) so re-sent history dedups: `selectNewMessages`
   * recomputes it from each stored id and filters the continuation message out,
   * so the split text is never re-forwarded (and duplicated) on later turns.
   */
  private static continuationMessageId(baseId: string): string {
    return `${baseId}${MastraAgent.ASSISTANT_TEXT_CONTINUATION_SUFFIX}`;
  }

  constructor(private config: MastraAgentConfig) {
    const {
      agent,
      resourceId,
      requestContext,
      untilIdle,
      tracingOptions,
      emitInterruptOutcome,
      a2ui,
      remoteClient,
      useProcessedFinalText,
      observationalMemory,
      ...rest
    } = config;
    super(rest);
    this.emitInterruptOutcome = emitInterruptOutcome ?? true;
    this.agent = agent;
    this.resourceId = resourceId;
    this.requestContext = requestContext ?? new RequestContext();
    this.untilIdle = untilIdle;
    this.a2ui = a2ui;
    this.remoteClient = remoteClient;
    this.useProcessedFinalText = useProcessedFinalText ?? false;
    this.observationalMemory = observationalMemory;
    this.tracingOptions = tracingOptions;
  }

  public clone() {
    const cloned = new MastraAgent(this.config);
    if (this.headers) {
      cloned.headers = { ...this.headers };
    }
    return cloned;
  }

  /**
   * Forwards `input.context` onto the Mastra RequestContext under "ag-ui", so a
   * tool reads it via `requestContext.get("ag-ui").context`. Called on every
   * entry path (initial stream + both resume paths) so a resumed run forwards
   * its own context instead of reusing the prior turn's.
   */
  private applyInputContext(context: RunAgentInput["context"]): RequestContext {
    this.requestContext ??= new RequestContext();
    this.requestContext.set("ag-ui", { context });
    return this.requestContext;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    // Fallback id used only until Mastra announces the persisted message id on
    // the start / step-start chunk (see onMessageId). Adopting Mastra's id
    // keeps the streamed assistant id equal to the stored id so re-sent history
    // dedupes instead of duplicating. Remote agents / older Mastra streams that
    // omit the start messageId keep using this fallback (and the rotation below).
    let messageId = randomUUID();

    // Tool suspends collected this run, mapped to AG-UI Interrupts. Only
    // populated when emitInterruptOutcome is on; the terminating RUN_FINISHED
    // carries them as a structured `outcome` (see makeRunFinishedEvent). The
    // legacy CUSTOM(on_interrupt) event is emitted regardless (see
    // onToolSuspended).
    const pendingInterrupts: Interrupt[] = [];

    return new Observable<BaseEvent>((subscriber) => {
      // A failed run must still terminate the AG-UI stream: emit RUN_ERROR as
      // the terminal event (mirrors LangGraph / AWS Strands) BEFORE surfacing
      // the failure on the rxjs error channel, which callers already depend on.
      const failRun = (error: unknown) => {
        if (subscriber.closed) return;
        subscriber.next({
          type: EventType.RUN_ERROR,
          message:
            error instanceof Error
              ? error.message
              : String(error ?? "Unknown error"),
        } as RunErrorEvent);
        subscriber.error(error);
      };

      const run = async () => {
        const runStartedEvent: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        };

        subscriber.next(runStartedEvent);

        // CopilotKit passes resume data via forwardedProps.command (convention
        // shared with LangGraph's interrupt bridge). forwardedProps is untyped
        // (any) — the caller is responsible for shape validation.
        let forwardedCommand = input.forwardedProps?.command;

        // Standard AG-UI resume channel: clients on the canonical interrupt path
        // (CopilotKit >= 1.61.2) drive resume through `RunAgentInput.resume`
        // (an array of { interruptId, status, payload }) instead of the legacy
        // `forwardedProps.command`. Mastra fully overrides run(), so the base
        // AbstractAgent reconcile of `input.resume` is bypassed — we consume it
        // here. We normalize the first entry into the same internal command shape
        // the legacy path uses, so a single resume block serves both channels.
        //
        // The Mastra snapshot runId (the resumeStream key) is NOT carried by a
        // ResumeEntry — only `interruptId` round-trips. So we encode the runId
        // into the emitted Interrupt id as `${runId}::${toolCallId}` (see
        // suspendToInterrupt) and decode it back here.
        if (!forwardedCommand?.interruptEvent && Array.isArray(input.resume)) {
          const entry = input.resume.find(
            (r) => r?.status === "resolved" || r?.status === "cancelled",
          );
          if (entry?.interruptId) {
            const sep = entry.interruptId.indexOf("::");
            const runId =
              sep >= 0 ? entry.interruptId.slice(0, sep) : input.runId;
            const toolCallId =
              sep >= 0 ? entry.interruptId.slice(sep + 2) : entry.interruptId;
            forwardedCommand = {
              resume: entry.status === "cancelled" ? false : entry.payload,
              interruptEvent: { toolCallId, runId },
            };
          }
        }

        // resume: false means the user explicitly declined the tool call.
        // Close the run cleanly without calling resumeStream.
        if (
          forwardedCommand?.resume === false &&
          forwardedCommand?.interruptEvent
        ) {
          await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as RunFinishedEvent);
          subscriber.complete();
          return;
        }

        if (
          forwardedCommand?.resume != null &&
          forwardedCommand?.interruptEvent
        ) {
          // Safely parse interruptEvent — client-supplied data
          let interruptEvent: any;
          try {
            interruptEvent =
              typeof forwardedCommand.interruptEvent === "string"
                ? JSON.parse(forwardedCommand.interruptEvent)
                : forwardedCommand.interruptEvent;
          } catch (err) {
            failRun(
              new Error("Invalid interruptEvent: malformed JSON", {
                cause: err,
              }),
            );
            return;
          }

          // Validate required fields for resume
          if (!interruptEvent?.toolCallId || !interruptEvent?.runId) {
            failRun(
              new Error("Invalid interruptEvent: missing toolCallId or runId"),
            );
            return;
          }

          // Re-set this run's context so resume forwards it, not the prior turn's.
          const resumeRequestContext = this.applyInputContext(input.context);

          // Resume options are shared verbatim by the local and remote paths.
          // Mastra keys the suspended snapshot by the runId surfaced on the
          // suspend chunk (round-tripped here as interruptEvent.runId), NOT the
          // AG-UI RunAgentInput.runId — passing the latter fails remote resume
          // with "No snapshot found for this workflow run". The remote instance
          // loads that snapshot from configured storage, so `memory` must point
          // at the same thread/resource the suspended run used.
          const resumeOptions: Record<string, unknown> = {
            toolCallId: interruptEvent.toolCallId,
            runId: interruptEvent.runId,
            memory: {
              thread: input.threadId,
              resource: this.resourceId ?? input.threadId,
            },
            requestContext: resumeRequestContext,
          };
          if (this.tracingOptions) {
            resumeOptions.tracingOptions = this.tracingOptions;
          }
          if (this.headers && Object.keys(this.headers).length > 0) {
            resumeOptions.modelSettings = {
              ...((resumeOptions.modelSettings as
                | Record<string, unknown>
                | undefined) ?? {}),
              headers: this.headers,
            };
          }

          const callbacks = this.makeStreamCallbacks(
            subscriber,
            () => messageId,
            (id) => {
              messageId = id;
            },
            input.runId,
            pendingInterrupts,
          );

          // Shared completion: emit a best-effort working-memory snapshot
          // (no-op for remote agents, which have no local memory) then
          // RUN_FINISHED. makeRunFinishedEvent attaches the structured
          // interrupt outcome when emitInterruptOutcome is on (e.g. a chained
          // interrupt in the resumed stream), so the resumed-run tail is
          // identical for local and remote.
          const finishResume = async (traceId?: string, usage?: TokenUsage[]) => {
            await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
            subscriber.next(
              this.makeRunFinishedEvent(
                input.threadId,
                input.runId,
                pendingInterrupts,
                traceId,
                usage,
              ),
            );
            subscriber.complete();
          };

          try {
            if (this.isLocalMastraAgent(this.agent)) {
              const response = await this.agent.resumeStream(
                forwardedCommand.resume,
                resumeOptions,
              );

              // Null/invalid response from resumeStream is an error
              if (
                !response ||
                typeof response !== "object" ||
                !response.fullStream
              ) {
                failRun(
                  new Error(
                    "resumeStream returned no valid response (missing fullStream)",
                  ),
                );
                return;
              }

              const hadError = await this.processFullStream(
                response.fullStream,
                {
                  ...callbacks,
                  onError: (error) => {
                    failRun(error);
                  },
                },
              );

              if (!hadError) {
                await finishResume(
                  await this.resolveTraceId(response),
                  await this.resolveUsage(response),
                );
              }
            } else {
              // Remote resume round-trips the suspend state + resume command
              // over @mastra/client-js. The remote Agent's resumeStream returns
              // a processDataStream response (callback-based), so we drive it
              // through the same createChunkProcessor used by the remote
              // .stream() path — single source of truth for chunk handling.
              const remoteAgent = this
                .agent as unknown as Partial<RemoteResumableAgent>;
              if (typeof remoteAgent.resumeStream !== "function") {
                failRun(
                  new Error(
                    "Resume from interrupt requires a @mastra/client-js version that supports agent.resumeStream(); please upgrade @mastra/client-js",
                  ),
                );
                return;
              }

              const response = await remoteAgent.resumeStream(
                forwardedCommand.resume,
                resumeOptions,
              );

              if (
                !response ||
                typeof response.processDataStream !== "function"
              ) {
                failRun(
                  new Error(
                    "resumeStream returned no valid response (missing processDataStream)",
                  ),
                );
                return;
              }

              let stopped = false;
              const { handleChunk, flush } = this.createChunkProcessor({
                ...callbacks,
                onError: (error) => {
                  failRun(error);
                },
              });

              await response.processDataStream({
                onChunk: async (chunk: any) => {
                  if (stopped) return;
                  if (handleChunk(chunk)) stopped = true;
                },
              });

              if (!stopped) {
                flush();
                await finishResume(
                  await this.resolveTraceId(response),
                  await this.resolveUsage(response),
                );
              }
            }
          } catch (error) {
            failRun(error);
          }
          return;
        }

        // Sync AG-UI input state into Mastra's working memory before streaming,
        // so a client-side edit to shared state (e.g. unchecking a dietary
        // preference in the recipe UI, then hitting "Improve") is what the agent
        // reads on the next run. Works for both local and remote agents (see
        // syncInputStateToWorkingMemory).
        try {
          await this.syncInputStateToWorkingMemory(input);
        } catch (error) {
          failRun(error);
          return;
        }

        try {
          const streamCallbacks = this.makeStreamCallbacks(
            subscriber,
            () => messageId,
            (id) => {
              messageId = id;
            },
            input.runId,
            pendingInterrupts,
          );

          await this.streamMastraAgent(input, {
            ...streamCallbacks,
            onError: (error) => {
              failRun(error);
            },
            onRunFinished: async (traceId, usage) => {
              await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
              subscriber.next(
                this.makeRunFinishedEvent(
                  input.threadId,
                  input.runId,
                  pendingInterrupts,
                  traceId,
                  usage,
                ),
              );
              subscriber.complete();
            },
          });
        } catch (error) {
          failRun(error);
        }
      };

      run().catch((err) => {
        failRun(err);
      });

      return () => {};
    });
  }

  isLocalMastraAgent(
    agent: LocalMastraAgent | RemoteMastraAgent,
  ): agent is LocalMastraAgent {
    return "getMemory" in agent;
  }

  /**
   * Maps a Mastra tool suspend to an AG-UI {@link Interrupt}.
   *
   * `id` is the suspended tool call id — the correlation key resume sends back
   * (alongside `runId`) via `resumeStream`. `responseSchema` is the parsed
   * `resumeSchema` (Mastra hands it over as a JSON string). Everything the
   * resume round-trip needs that has no first-class Interrupt field
   * (`toolName`, `suspendPayload`, `args`, the snapshot-keying `runId`) is
   * preserved under `metadata.mastra`, shaped like the legacy on_interrupt
   * value so a standard-path client can reconstruct the resume directive.
   */
  private suspendToInterrupt(
    payload: {
      toolCallId: string;
      toolName: string;
      suspendPayload: any;
      args: Record<string, any>;
      resumeSchema: string;
      runId?: string;
    },
    runId: string,
  ): Interrupt {
    let responseSchema: Record<string, any> | undefined;
    const rawSchema = payload.resumeSchema as unknown;
    if (typeof rawSchema === "string" && rawSchema.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawSchema);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          responseSchema = parsed;
        }
      } catch {
        // resumeSchema is not valid JSON — omit responseSchema; the raw value
        // is still carried in metadata.mastra below.
      }
    } else if (
      rawSchema &&
      typeof rawSchema === "object" &&
      !Array.isArray(rawSchema)
    ) {
      responseSchema = rawSchema as Record<string, any>;
    }

    // Encode the snapshot runId into the interrupt id as `${runId}::${toolCallId}`.
    // A standard-path client (CopilotKit >= 1.61.2) only round-trips `interruptId`
    // in its ResumeEntry — not metadata — so the id is the one channel that can
    // carry the runId resume needs (see the input.resume consumer in run()).
    // `toolCallId` stays its own field for the legacy path and for renderers.
    const snapshotRunId = payload.runId ?? runId;
    return {
      id: `${snapshotRunId}::${payload.toolCallId}`,
      reason: "mastra:tool_suspend",
      toolCallId: payload.toolCallId,
      ...(responseSchema ? { responseSchema } : {}),
      metadata: {
        mastra: {
          type: "mastra_suspend",
          toolName: payload.toolName,
          suspendPayload: payload.suspendPayload,
          args: payload.args,
          resumeSchema: payload.resumeSchema,
          // The id Mastra keys the suspended snapshot by (see onToolSuspended).
          runId: snapshotRunId,
        },
      },
    };
  }

  /**
   * Builds the terminating RUN_FINISHED for a run. When emitInterruptOutcome is
   * on AND the run suspended at least one tool, attaches the structured
   * `outcome: { type: "interrupt", interrupts }`. Otherwise emits a plain
   * RUN_FINISHED — the legacy/default behavior. Mirrors LangGraph's
   * `dispatchInterruptFinish`.
   *
   * When the run exposed a Mastra execution traceId (Mastra observability
   * v-next), it is surfaced on `RUN_FINISHED.result` as `{ traceId }` so the
   * client/runtime can correlate the produced assistant message with its trace
   * (e.g. to anchor trace-centric feedback/scores). `result` is left unset
   * otherwise, preserving the prior event shape.
   */
  private makeRunFinishedEvent(
    threadId: string,
    runId: string,
    interrupts: Interrupt[],
    traceId?: string,
    usage?: TokenUsage[],
  ): RunFinishedEvent {
    const includeOutcome = this.emitInterruptOutcome && interrupts.length > 0;
    return {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      ...(traceId ? { result: { traceId } } : {}),
      ...(includeOutcome
        ? {
            outcome: {
              type: "interrupt",
              interrupts,
            } satisfies RunFinishedInterruptOutcome,
          }
        : {}),
      ...(usage && usage.length > 0 ? { usage } : {}),
    } as RunFinishedEvent;
  }

  /**
   * Resolve provider-reported token usage from a Mastra/AI-SDK stream result.
   * AI-SDK v5 exposes a `usage` promise ({ inputTokens, outputTokens, ... });
   * we map it into a single per-run TokenUsage entry, labelling provider/model
   * from the local agent's model when discoverable. Best-effort: any failure
   * (no usage, remote agent, rejected promise) yields an empty array so the run
   * still finishes without usage.
   */
  private async resolveUsage(response: any): Promise<TokenUsage[]> {
    try {
      const raw = await response?.usage;
      const identity = this.getModelIdentity();
      const entry = tokenUsageFromAiSdkUsage(raw, identity);
      return entry ? [entry] : [];
    } catch {
      return [];
    }
  }

  /** Best-effort provider/model of the configured local agent (undefined for
   * remote agents or when the model doesn't expose these). */
  private getModelIdentity(): { provider?: string; model?: string } {
    const model = (this.agent as any)?.model;
    const provider = typeof model?.provider === "string" ? model.provider : undefined;
    const modelId = typeof model?.modelId === "string" ? model.modelId : undefined;
    return { provider, model: modelId };
  }

  /**
   * Fetches working memory from a local agent and emits a STATE_SNAPSHOT event
   * if valid working memory is available.
   *
   * Best-effort: logs a warning and returns gracefully on failure so callers
   * can proceed with RUN_FINISHED even when the snapshot could not be delivered.
   */
  private async emitWorkingMemorySnapshot(
    subscriber: { next: (event: BaseEvent) => void },
    threadId: string,
  ): Promise<boolean> {
    if (!this.isLocalMastraAgent(this.agent)) return true;
    try {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (memory) {
        const workingMemory = await memory.getWorkingMemory({
          resourceId: this.resourceId ?? threadId,
          threadId,
          memoryConfig: {
            workingMemory: {
              enabled: true,
            },
          },
        });

        if (typeof workingMemory === "string") {
          let snapshot: Record<string, any> | null = null;
          try {
            snapshot = JSON.parse(workingMemory);
          } catch {
            // Working memory is not valid JSON (e.g. markdown template)
            // Wrap it so the client still receives the state
            snapshot = { workingMemory };
          }

          // Skip snapshots containing a JSON Schema definition ($schema) —
          // these are Mastra's working-memory templates, not actual state.
          if (snapshot && !("$schema" in snapshot)) {
            subscriber.next({
              type: EventType.STATE_SNAPSHOT,
              snapshot,
            } as StateSnapshotEvent);
          }
        }
      }
      return true;
    } catch (error) {
      console.warn(
        `[MastraAgent] Failed to emit working memory snapshot for thread ${threadId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Creates the callback set used by processFullStream to emit AG-UI events.
   * messageId is accessed/mutated via getter/setter closures so that when
   * onFinishMessagePart replaces the ID with a new UUID, subsequent callbacks
   * in the same run() invocation see the updated value.
   */
  private makeStreamCallbacks(
    subscriber: { next: (event: BaseEvent) => void },
    getMessageId: () => string,
    setMessageId: (id: string) => void,
    runId: string,
    pendingInterrupts: Interrupt[],
  ): Omit<MastraAgentStreamOptions, "onError" | "onRunFinished"> {
    let reasoningMessageId: string | null = null;
    let isReasoning = false;

    // --- Assistant message-ordering fix (backend tool -> trailing text) ------
    // Mastra assigns ONE messageId to an entire assistant turn and re-announces
    // it on each step-start, so a backend tool call and the model's final
    // narration text (streamed in a later step) both land under it. Under a
    // single AG-UI messageId CopilotKit draws a message's text BEFORE its tool
    // calls, so the narration renders ABOVE the tool card (and, for A2UI, above
    // the generated surface) even though it streamed LAST. To restore
    // card -> result -> text order, any assistant text that would stream under a
    // messageId that already carries a tool call is split into a SEPARATE
    // continuation message, keyed by a deterministic id derived from that id
    // (so re-sent history still dedups; see selectNewMessages).
    //
    // Keying off the tool call's own parent id (rather than a per-turn flag)
    // keeps the split correct whether Mastra re-announces the same id across the
    // step boundary (the real bug: text collapses onto the tool id) or omits
    // the id and relies on messageId rotation (each step already gets a fresh
    // id, so nothing collides and no split happens).
    const toolCallParentIds = new Set<string>();

    const closeReasoning = () => {
      if (isReasoning && reasoningMessageId) {
        subscriber.next({
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId,
        } as ReasoningMessageEndEvent);
        subscriber.next({
          type: EventType.REASONING_END,
          messageId: reasoningMessageId,
        } as ReasoningEndEvent);
        isReasoning = false;
        reasoningMessageId = null;
      }
    };

    const openReasoning = () => {
      if (!isReasoning) {
        reasoningMessageId = randomUUID();
        isReasoning = true;
        subscriber.next({
          type: EventType.REASONING_START,
          messageId: reasoningMessageId,
        } as ReasoningStartEvent);
        subscriber.next({
          type: EventType.REASONING_MESSAGE_START,
          messageId: reasoningMessageId,
          role: "reasoning",
        } as ReasoningMessageStartEvent);
      }
    };

    return {
      onMessageId: (id) => {
        setMessageId(id);
      },
      onReasoningStart: () => {
        openReasoning();
      },
      onReasoningPart: (text) => {
        openReasoning();
        subscriber.next({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: reasoningMessageId!,
          delta: text,
        } as ReasoningMessageContentEvent);
      },
      onReasoningEnd: () => {
        closeReasoning();
      },
      onTextPart: (text) => {
        closeReasoning();
        // If this text would stream under a messageId that already carries a
        // tool call, split it into its own continuation message so it renders
        // BELOW the tool card/result (see the ordering note above). Text under
        // a fresh id (no tool call on it) keeps that id — including text that
        // legitimately precedes a tool call in the same message.
        const currentId = getMessageId();
        const textMessageId = toolCallParentIds.has(currentId)
          ? MastraAgent.continuationMessageId(currentId)
          : currentId;
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          role: "assistant",
          messageId: textMessageId,
          delta: text,
        } as TextMessageChunkEvent);
      },
      onToolCallStart: (streamPart) => {
        closeReasoning();
        const parentMessageId = getMessageId();
        // Record the id this tool call renders under; trailing text on the same
        // id is then split to a continuation message (see onTextPart).
        toolCallParentIds.add(parentMessageId);
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          parentMessageId,
          toolCallId: streamPart.toolCallId,
          toolCallName: streamPart.toolName,
        } as ToolCallStartEvent);
      },
      onToolCallArgs: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: streamPart.toolCallId,
          delta: streamPart.argsTextDelta,
        } as ToolCallArgsEvent);
      },
      onToolCallEnd: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: streamPart.toolCallId,
        } as ToolCallEndEvent);
      },
      onToolResultPart: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: streamPart.toolCallId,
          content: JSON.stringify(streamPart.result),
          messageId: randomUUID(),
          role: "tool",
        } as ToolCallResultEvent);
      },
      onToolSuspended: (payload) => {
        // Legacy path: always emitted (backward compat, owner decision). The
        // wrapper stays even when emitInterruptOutcome is on.
        subscriber.next({
          type: EventType.CUSTOM,
          name: "on_interrupt",
          value: JSON.stringify({
            type: "mastra_suspend",
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            suspendPayload: payload.suspendPayload,
            args: payload.args,
            resumeSchema: payload.resumeSchema,
            // Prefer the runId Mastra reported on the suspend chunk (the id its
            // snapshot is keyed by); fall back to the AG-UI run's id when the
            // chunk omits one. The resume path round-trips this exact value.
            runId: payload.runId ?? runId,
          }),
        } as CustomEvent);

        // Standard path (opt-in): accumulate the suspend as an AG-UI Interrupt
        // so the terminating RUN_FINISHED carries the structured outcome. Kept
        // separate from the legacy event above — both fire when the flag is on.
        if (this.emitInterruptOutcome) {
          pendingInterrupts.push(this.suspendToInterrupt(payload, runId));
        }
      },
      onFinishMessagePart: () => {
        closeReasoning();
        setMessageId(randomUUID());
      },
      onActivitySnapshot: ({ messageId, activityType, content }) => {
        subscriber.next({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId,
          activityType,
          content,
        } as ActivitySnapshotEvent);
      },
      onActivityDelta: ({ messageId, activityType, patch }) => {
        subscriber.next({
          type: EventType.ACTIVITY_DELTA,
          messageId,
          activityType,
          patch,
        } as ActivityDeltaEvent);
      },
      onStateSnapshot: (snapshot) => {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot,
        } as StateSnapshotEvent);
      },
      onStateDelta: (delta) => {
        subscriber.next({
          type: EventType.STATE_DELTA,
          delta,
        } as StateDeltaEvent);
      },
    };
  }

  /**
   * Creates a stateful chunk processor that maps Mastra stream chunks to
   * AG-UI events via callbacks.
   *
   * Tool-call args are streamed incrementally: Mastra emits
   * `tool-call-input-streaming-start` → one or more `tool-call-delta` (each a
   * raw JSON-text fragment) → `tool-call-input-streaming-end` → a final
   * `tool-call` (with the assembled args) as the model produces the call.
   * When those delta chunks are present we emit TOOL_CALL_START on the start
   * chunk, a TOOL_CALL_ARGS per delta, and TOOL_CALL_END on the end chunk —
   * so the client renders args as they arrive. The trailing `tool-call` for an
   * already-streamed id is a no-op (args were already emitted).
   *
   * Fall-back (backwards compatibility): older @mastra/core in the supported
   * 1.0.x floor may emit only the final `tool-call` with no delta chunks. In
   * that case we buffer the `tool-call` and emit a single START + full-args
   * ARGS + END when it flushes. This buffered path also preserves the
   * suspend protocol: if a buffered tool-call is followed by
   * tool-call-suspended, the TOOL_CALL_* events are suppressed (the tool
   * hasn't executed yet — emitting them confuses CopilotKit's orchestration
   * which expects a TOOL_CALL_RESULT to follow). Suspendable tools are
   * server-side and travel the buffered path; client/generative tools (which
   * never suspend) are the ones whose args stream incrementally.
   *
   * Used by both the local agent path (async iterable) and the remote agent
   * path (processDataStream callback) — single source of truth for chunk
   * handling and buffering logic.
   *
   * @returns An object with two methods:
   *   - `handleChunk`: processes a single chunk; returns `true` if processing should stop (error or malformed chunk).
   *   - `flush`: emits any buffered tool-call (call at end of stream).
   */
  private createChunkProcessor(
    callbacks: MastraAgentStreamOptions,
    clientToolNames: Set<string> = new Set(),
    initialState: Record<string, any> = {},
  ) {
    // Running client-side working-memory state, mapped to AG-UI shared state.
    // Seeded from the run's input.state (the base the client already holds), so
    // the first STATE_DELTA patches from what the UI shows, not from empty.
    // Each `updateWorkingMemory` tool call advances it and emits the patch.
    let workingMemoryState: Record<string, any> =
      initialState && typeof initialState === "object"
        ? { ...initialState }
        : {};
    // Tool call ids for `updateWorkingMemory` calls — used to suppress their
    // normal tool render (the update surfaces as STATE_DELTA, not a tool pill)
    // and to swallow the following `{ success: true }` tool-result.
    const workingMemoryToolCalls = new Set<string>();
    // The in-flight `updateWorkingMemory` call whose args are streaming: we
    // accumulate its raw `tool-call-delta` text and re-parse the growing prefix
    // so shared state renders progressively (field by field) rather than as one
    // blob when the call completes.
    let workingMemoryStream: { toolCallId: string; argsText: string } | null =
      null;

    // Whether we've emitted the leading STATE_SNAPSHOT for this run yet. The
    // AG-UI runtime applies STATE_DELTA against a document that starts EMPTY at
    // run start (it does not seed from input.state), so the first working-memory
    // state event MUST be a full STATE_SNAPSHOT — it establishes the base the
    // runtime and client patch against. Without it the first delta's paths (e.g.
    // `replace /recipe/skill_level`) are unresolvable → the runtime throws
    // OPERATION_PATH_UNRESOLVABLE, the run never finishes, and the Mastra thread
    // lock is never released ("Thread already running" on the next run).
    let stateSnapshotEmitted = false;

    // Advance the tracked shared state to the post-update value. The FIRST
    // change of a run is emitted as a STATE_SNAPSHOT (establishes the base);
    // every change after that as a STATE_DELTA (RFC-6902 patch, no-op if
    // nothing changed). Seeding `workingMemoryState` from input.state means the
    // snapshot preserves fields the streamed prefix hasn't written yet (no
    // transient collapse of the existing recipe). Shared by the streaming and
    // final-chunk paths so both advance the same state.
    const emitWorkingMemoryState = (
      update: Record<string, any> | undefined,
    ) => {
      if (update === undefined) return;
      const next = deepMergeWorkingMemory(workingMemoryState, update);
      if (!stateSnapshotEmitted) {
        stateSnapshotEmitted = true;
        workingMemoryState = next;
        callbacks.onStateSnapshot?.(next);
        return;
      }
      const patch = compare(workingMemoryState, next);
      if (patch.length > 0) {
        workingMemoryState = next;
        callbacks.onStateDelta?.(patch as Array<Record<string, any>>);
      }
    };

    // Whether to surface Observational Memory background work as activity
    // events. OFF by default — see MastraAgentConfig.observationalMemory.
    const surfaceOM = !!this.observationalMemory;

    // Only CLIENT (frontend) tools stream their args live — they are the
    // generative-UI tools that benefit from progressive rendering, and they
    // never suspend or background. SERVER tools take the buffered path below so
    // a following `tool-call-suspended` / `background-task-started` can still
    // suppress the normal render (you cannot retract an already-emitted live
    // arg stream). The bridge knows which tools are client tools because they
    // arrive in `RunAgentInput.tools` (→ `clientTools`); server tools live on
    // the Mastra agent and are absent from that set.
    const isClientTool = (toolName?: string) =>
      !!toolName && clientToolNames.has(toolName);

    // Floor / fall-back path: a final `tool-call` with no preceding client
    // delta stream is buffered here so a following tool-call-suspended /
    // background-task-started can suppress it (and reuse its args). Tool calls
    // that streamed deltas live are NOT buffered.
    let pendingToolCall: {
      toolCallId: string;
      toolName: string;
      args: any;
    } | null = null;
    // Tool calls for which we have emitted TOOL_CALL_START via the streaming
    // (delta) path, and (separately) for which we have emitted TOOL_CALL_END.
    const streamedStarted = new Set<string>();
    const streamedEnded = new Set<string>();

    // Skipped / unrecognized chunk types warn at most once each. Mastra 1.31+
    // custom-data streams (e.g. `data-*` via context.writer.custom) can emit
    // the same payload-less type at high frequency; a per-chunk warn would
    // flood the log (#1635). Dedupe by type so integrators still see the
    // message without the spam.
    const warnedChunkTypes = new Set<string>();
    const warnOnce = (type: string | undefined, message: string) => {
      const key = type ?? "undefined";
      if (warnedChunkTypes.has(key)) return;
      warnedChunkTypes.add(key);
      console.warn(`[MastraAgent] ${message}: type=${key}`);
    };

    const startStreamedToolCall = (toolCallId: string, toolName: string) => {
      if (!streamedStarted.has(toolCallId)) {
        streamedStarted.add(toolCallId);
        callbacks.onToolCallStart?.({ toolCallId, toolName });
      }
    };

    const endStreamedToolCall = (toolCallId: string) => {
      if (streamedStarted.has(toolCallId) && !streamedEnded.has(toolCallId)) {
        streamedEnded.add(toolCallId);
        callbacks.onToolCallEnd?.({ toolCallId });
      }
    };

    const flush = () => {
      if (pendingToolCall) {
        const { toolCallId, toolName, args } = pendingToolCall;
        pendingToolCall = null;
        callbacks.onToolCallStart?.({ toolCallId, toolName });
        callbacks.onToolCallArgs?.({
          toolCallId,
          // The buffered path has the assembled args object — serialize the
          // whole thing as a single delta (the streaming path emits the raw
          // JSON-text fragments instead).
          argsTextDelta: JSON.stringify(args ?? {}),
        });
        callbacks.onToolCallEnd?.({ toolCallId });
      }
    };

    // --- useProcessedFinalText buffering ------------------------------------
    // When the flag is on, `text-delta` chunks are accumulated here instead of
    // streamed, and the assistant text is emitted once per boundary from the
    // processor-modified `finish.payload.response.uiMessages` (falling back to
    // this raw buffer on the terminal `finish`). All of this is inert when the
    // flag is off — bufferedText stays "" and the release helpers early-return.
    let bufferedText = "";
    // The last text we emitted within the current message window. Mastra ends a
    // response with a `step-finish` immediately followed by a terminal `finish`,
    // and BOTH can carry the same `response.uiMessages`; without this guard the
    // second boundary would re-emit the identical text as a duplicate bubble
    // (under the already-rotated messageId). Reset on each start / step-start so
    // dedup is scoped to one message and never suppresses distinct per-step text.
    let lastEmittedText: string | undefined;

    // Emit `text` as one assistant TEXT_MESSAGE_CHUNK, skipping an exact repeat
    // of what we just emitted for this message (see lastEmittedText).
    const emitProcessedText = (text: string) => {
      if (text === lastEmittedText) return;
      callbacks.onTextPart?.(text);
      lastEmittedText = text;
    };

    // Release buffered/processed assistant text at a finish boundary. Prefers
    // the processor-modified text from `uiMessages`; on the terminal `finish`
    // falls back to the raw buffer so nothing is dropped. On a non-terminal
    // `step-finish` with no `uiMessages`, keeps buffering (the text may still be
    // rewritten and surfaced on a later boundary — emitting raw now then
    // processed later would double-render).
    const releaseBufferedText = (chunkPayload: any, isTerminal: boolean) => {
      if (!this.useProcessedFinalText) return;
      const processedText = extractLastAssistantText(
        chunkPayload?.response?.uiMessages,
      );
      if (processedText !== undefined) {
        bufferedText = "";
        emitProcessedText(processedText);
        return;
      }
      if (isTerminal && bufferedText) {
        const raw = bufferedText;
        bufferedText = "";
        emitProcessedText(raw);
      }
    };

    // Flush the raw buffer as-is (used when a turn ends without a `finish`, e.g.
    // a tool suspend/interrupt) so text streamed before the interrupt is not
    // lost. No-op when the flag is off or nothing is buffered.
    const flushBufferedTextRaw = () => {
      if (!this.useProcessedFinalText || !bufferedText) return;
      const raw = bufferedText;
      bufferedText = "";
      emitProcessedText(raw);
    };

    // taskIds for which an ACTIVITY_SNAPSHOT has already been emitted. Guards
    // against emitting a delta before its snapshot and bounds progress ticks to
    // tasks the client knows about.
    const knownTasks = new Set<string>();

    // Maps an in-flight background tool call (by toolCallId) to its task, so we
    // can correlate the loop's inline `tool-result` / `tool-error` back to the
    // activity. When a backgrounded tool finishes within the agent loop's wait
    // window, Mastra surfaces only `background-task-started` on the main stream
    // and delivers the outcome as an ordinary `tool-result` — there is no
    // `background-task-completed` here (that lives on the manager's own stream).
    const backgroundToolCalls = new Map<
      string,
      { taskId: string; toolName?: string }
    >();

    const toISO = (value: unknown): unknown =>
      value instanceof Date ? value.toISOString() : value;

    // Seed an activity for a task if we haven't already (defensive: a running /
    // output chunk should always follow a started chunk, but a delta with no
    // prior snapshot would be unrenderable).
    const ensureTaskSnapshot = (payload: any) => {
      const { taskId, toolName, toolCallId, args } = payload ?? {};
      if (!taskId || knownTasks.has(taskId)) return;
      knownTasks.add(taskId);
      const content: Record<string, any> = {
        taskId,
        toolName,
        toolCallId,
        // The task is dispatched and executing out of band; surface it as
        // "running" so the UI reads as active immediately (the inline path
        // never emits a separate running delta).
        status: "running",
        outputs: [],
      };
      if (args !== undefined) content.args = args;
      callbacks.onActivitySnapshot?.({
        messageId: taskId,
        activityType: MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE,
        content,
      });
    };

    const emitTaskDelta = (
      taskId: string,
      patch: Array<Record<string, any>>,
    ) => {
      if (!taskId || patch.length === 0) return;
      callbacks.onActivityDelta?.({
        messageId: taskId,
        activityType: MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE,
        patch,
      });
    };

    // --- Observational Memory (OM) activity ---------------------------------
    // cycleIds for which an OM ACTIVITY_SNAPSHOT has been emitted. Guards
    // against emitting a delta before its snapshot.
    const knownOmCycles = new Set<string>();

    const ensureOmSnapshot = (
      cycleId: string,
      content: Record<string, any>,
    ) => {
      if (!cycleId || knownOmCycles.has(cycleId)) return;
      knownOmCycles.add(cycleId);
      callbacks.onActivitySnapshot?.({
        messageId: cycleId,
        activityType: MASTRA_OBSERVATIONAL_MEMORY_ACTIVITY_TYPE,
        content: { cycleId, ...content },
      });
    };

    const emitOmDelta = (
      cycleId: string,
      patch: Array<Record<string, any>>,
    ) => {
      if (!cycleId || patch.length === 0) return;
      callbacks.onActivityDelta?.({
        messageId: cycleId,
        activityType: MASTRA_OBSERVATIONAL_MEMORY_ACTIVITY_TYPE,
        patch,
      });
    };

    // Build a JSON-patch "add" op for each defined field on `data` under
    // `keyMap` (sourceKey -> activity content path). Skips undefined values so
    // the delta stays minimal. Date values are normalised to ISO strings.
    const omPatch = (
      data: Record<string, any>,
      keyMap: Record<string, string>,
    ): Array<Record<string, any>> => {
      const patch: Array<Record<string, any>> = [];
      for (const [src, path] of Object.entries(keyMap)) {
        const value = data?.[src];
        if (value === undefined) continue;
        patch.push({ op: "add", path: `/${path}`, value: toISO(value) });
      }
      return patch;
    };

    // Map a single OM `data-om-*` chunk to activity events. Snapshot on the
    // start of a cycle, delta on its end/failure; activation is terminal so it
    // is a snapshot of its own. Only the substantive lifecycle is surfaced —
    // `data-om-status` (periodic token-window gauge), `data-om-thread-update`
    // (title changes) and the deprecated `data-om-observed` are intentionally
    // ignored (still swallowed, never a stream-stopper). The cycleId round-trips
    // as the activity messageId so start/end address the same activity message.
    const handleOmChunk = (chunk: any): void => {
      const data = chunk?.data ?? {};
      const cycleId: string | undefined = data.cycleId;
      switch (chunk.type) {
        case "data-om-observation-start": {
          if (!cycleId) break;
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "observation",
            status: "running",
            ...(data.threadId !== undefined && { threadId: data.threadId }),
            ...(data.recordId !== undefined && { recordId: data.recordId }),
            ...(data.startedAt !== undefined && {
              startedAt: toISO(data.startedAt),
            }),
            ...(data.tokensToObserve !== undefined && {
              tokensToObserve: data.tokensToObserve,
            }),
          });
          break;
        }
        case "data-om-buffering-start": {
          if (!cycleId) break;
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "buffering",
            status: "running",
            ...(data.threadId !== undefined && { threadId: data.threadId }),
            ...(data.recordId !== undefined && { recordId: data.recordId }),
            ...(data.startedAt !== undefined && {
              startedAt: toISO(data.startedAt),
            }),
            ...(data.tokensToBuffer !== undefined && {
              tokensToBuffer: data.tokensToBuffer,
            }),
          });
          break;
        }
        case "data-om-observation-end": {
          if (!cycleId) break;
          // Defensive: seed a snapshot if the start chunk was missed.
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "observation",
            status: "running",
          });
          emitOmDelta(cycleId, [
            { op: "add", path: "/status", value: "completed" },
            ...omPatch(data, {
              completedAt: "completedAt",
              durationMs: "durationMs",
              tokensObserved: "tokensObserved",
              observationTokens: "observationTokens",
              observations: "observations",
              currentTask: "currentTask",
              suggestedResponse: "suggestedResponse",
            }),
          ]);
          break;
        }
        case "data-om-buffering-end": {
          if (!cycleId) break;
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "buffering",
            status: "running",
          });
          emitOmDelta(cycleId, [
            { op: "add", path: "/status", value: "completed" },
            ...omPatch(data, {
              completedAt: "completedAt",
              durationMs: "durationMs",
              tokensBuffered: "tokensBuffered",
              bufferedTokens: "bufferedTokens",
              observations: "observations",
            }),
          ]);
          break;
        }
        case "data-om-observation-failed":
        case "data-om-buffering-failed": {
          if (!cycleId) break;
          const phase =
            chunk.type === "data-om-buffering-failed"
              ? "buffering"
              : "observation";
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase,
            status: "running",
          });
          emitOmDelta(cycleId, [
            { op: "add", path: "/status", value: "failed" },
            {
              op: "add",
              path: "/error",
              value: data.error ?? "Unknown error",
            },
            ...omPatch(data, {
              failedAt: "completedAt",
              durationMs: "durationMs",
            }),
          ]);
          break;
        }
        case "data-om-activation": {
          // Activation moves buffered observations into the active context. In
          // the async path it REUSES the buffering cycle's id (buffering-start/
          // -end then activation all share one cycleId), so when the cycle is
          // already known this is the terminal DELTA that advances that activity
          // to "activated". When the cycle is unknown (defensive / a future path
          // that activates without a prior buffering cycle on this stream) it is
          // a self-contained snapshot.
          if (!cycleId) break;
          const activationPatch = (data: Record<string, any>) =>
            omPatch(data, {
              activatedAt: "completedAt",
              chunksActivated: "chunksActivated",
              tokensActivated: "tokensActivated",
              observationTokens: "observationTokens",
              messagesActivated: "messagesActivated",
              generationCount: "generationCount",
              triggeredBy: "triggeredBy",
              observations: "observations",
            });
          if (knownOmCycles.has(cycleId)) {
            emitOmDelta(cycleId, [
              { op: "add", path: "/phase", value: "activation" },
              { op: "add", path: "/status", value: "activated" },
              ...activationPatch(data),
            ]);
          } else {
            ensureOmSnapshot(cycleId, {
              operationType: data.operationType,
              phase: "activation",
              status: "activated",
              ...(data.threadId !== undefined && { threadId: data.threadId }),
              ...(data.recordId !== undefined && { recordId: data.recordId }),
              ...(data.activatedAt !== undefined && {
                completedAt: toISO(data.activatedAt),
              }),
              ...(data.chunksActivated !== undefined && {
                chunksActivated: data.chunksActivated,
              }),
              ...(data.tokensActivated !== undefined && {
                tokensActivated: data.tokensActivated,
              }),
              ...(data.observationTokens !== undefined && {
                observationTokens: data.observationTokens,
              }),
              ...(data.messagesActivated !== undefined && {
                messagesActivated: data.messagesActivated,
              }),
              ...(data.generationCount !== undefined && {
                generationCount: data.generationCount,
              }),
              ...(data.triggeredBy !== undefined && {
                triggeredBy: data.triggeredBy,
              }),
              ...(data.observations !== undefined && {
                observations: data.observations,
              }),
            });
          }
          break;
        }
        default:
          // data-om-status / data-om-thread-update / data-om-observed and any
          // future data-om-* part: swallow without surfacing.
          break;
      }
    };

    const handleChunk = (chunk: any): boolean => {
      // Observational Memory data parts arrive on fullStream as
      // `{ type: "data-om-*", data: {...} }` (no `payload`). Handle them before
      // the payload guard below so they map to activity when surfacing is on,
      // and are swallowed silently (no warn) when off — an OM-enabled agent
      // still streams cleanly and emits no activity.
      if (
        typeof chunk?.type === "string" &&
        chunk.type.startsWith("data-om-")
      ) {
        if (surfaceOM) handleOmChunk(chunk);
        return false;
      }

      // Other chunks without a `payload` are not fatal. Mastra 1.31+ emits
      // custom-data chunks (e.g. `data-*` types via context.writer.custom)
      // that carry `data` instead of `payload`, plus new lifecycle chunk
      // types this switch doesn't recognize. Skip them gracefully (warn,
      // return false) so the rest of the stream — including RUN_FINISHED —
      // still flows, rather than aborting the run.
      if (!chunk || !chunk.payload) {
        warnOnce(chunk?.type, "Skipping stream chunk without payload");
        return false;
      }
      switch (chunk.type) {
        case "reasoning-start": {
          callbacks.onReasoningStart?.();
          break;
        }
        case "reasoning-delta": {
          callbacks.onReasoningPart?.(chunk.payload.text);
          break;
        }
        case "reasoning-end": {
          callbacks.onReasoningEnd?.();
          break;
        }
        case "reasoning-signature":
        case "redacted-reasoning":
          break;
        // Mastra 1.31+ text lifecycle markers bracket the `text-delta` chunks.
        // AG-UI streams text via TEXT_MESSAGE_CHUNK and derives message
        // boundaries from start/finish + messageId rotation, so these markers
        // need no action — recognize them so they don't hit the `default:`
        // warning flood (#1635, #836).
        case "text-start":
        case "text-end":
          break;
        // A standalone (non-background) `tool-output` streams intermediate tool
        // output. The bridge surfaces completed tool results via `tool-result`;
        // there is no AG-UI mapping for interim output, so ignore it. (Task
        // output under a backgrounded tool is consumed inside
        // `background-task-output`, not here.) Recognized to avoid the warn.
        case "tool-output":
          break;
        case "text-delta": {
          flush();
          if (this.useProcessedFinalText) {
            // Hold deltas until a finish boundary — the processor-modified text
            // arrives via finish.payload.response.uiMessages.
            bufferedText += chunk.payload.text;
          } else {
            callbacks.onTextPart?.(chunk.payload.text);
          }
          break;
        }
        // Tool-call args stream incrementally: start → delta(s) → end → the
        // final `tool-call`. For CLIENT tools we emit these live (progressive
        // render). For SERVER tools we ignore the delta chunks and buffer the
        // final `tool-call` (below) so it stays suppressible.
        case "tool-call-input-streaming-start": {
          // A new tool call begins — flush any prior buffered (floor-path) call.
          flush();
          // Working-memory update: capture its streaming args so we can emit
          // progressive STATE_DELTAs (below). It never renders as a tool.
          if (
            chunk.payload.toolCallId &&
            WORKING_MEMORY_TOOL_NAMES.has(chunk.payload.toolName)
          ) {
            workingMemoryStream = {
              toolCallId: chunk.payload.toolCallId,
              argsText: "",
            };
            workingMemoryToolCalls.add(chunk.payload.toolCallId);
            break;
          }
          if (
            chunk.payload.toolCallId &&
            isClientTool(chunk.payload.toolName)
          ) {
            startStreamedToolCall(
              chunk.payload.toolCallId,
              chunk.payload.toolName,
            );
          }
          break;
        }
        case "tool-call-delta": {
          const { toolCallId, argsTextDelta } = chunk.payload;
          // Working-memory update streaming: accumulate the raw args text and
          // re-parse the growing prefix, emitting an incremental STATE_DELTA as
          // the model writes the update (progressive shared-state render).
          if (
            workingMemoryStream &&
            toolCallId === workingMemoryStream.toolCallId
          ) {
            if (argsTextDelta != null) {
              workingMemoryStream.argsText += argsTextDelta;
              emitWorkingMemoryState(
                parseStreamingWorkingMemoryUpdate(workingMemoryStream.argsText),
              );
            }
            break;
          }
          // Only forward deltas for a call we opened as a live (client) stream.
          // Server-tool deltas are ignored; their args ride the final
          // `tool-call` chunk into the buffered path.
          if (
            toolCallId &&
            streamedStarted.has(toolCallId) &&
            argsTextDelta != null
          ) {
            callbacks.onToolCallArgs?.({ toolCallId, argsTextDelta });
          }
          break;
        }
        case "tool-call-input-streaming-end": {
          if (
            workingMemoryStream &&
            chunk.payload.toolCallId === workingMemoryStream.toolCallId
          ) {
            // Args fully streamed; the authoritative final state is emitted from
            // the following `tool-call` chunk (its assembled object). Stop
            // accumulating; keep the id suppressed for the tool-result.
            workingMemoryStream = null;
            break;
          }
          if (chunk.payload.toolCallId) {
            endStreamedToolCall(chunk.payload.toolCallId);
          }
          break;
        }
        case "tool-call": {
          const { toolCallId, toolName, args } = chunk.payload;
          // Working-memory update: Mastra's built-in `updateWorkingMemory` tool.
          // The assembled args carry the final (authoritative) working memory —
          // emit a STATE_DELTA to it (a no-op patch if the streamed deltas above
          // already converged, or the whole change on the fall-back path where
          // no arg-deltas streamed). Suppress the normal tool render; the
          // `{ success: true }` result is swallowed below. A preceding buffered
          // (floor-path) call still flushes first.
          if (toolName && WORKING_MEMORY_TOOL_NAMES.has(toolName)) {
            flush();
            if (toolCallId) workingMemoryToolCalls.add(toolCallId);
            if (
              workingMemoryStream &&
              workingMemoryStream.toolCallId === toolCallId
            ) {
              workingMemoryStream = null;
            }
            emitWorkingMemoryState(parseWorkingMemoryUpdate(args));
            break;
          }
          if (toolCallId && streamedStarted.has(toolCallId)) {
            // Client tool: args were already streamed live via deltas — close
            // the call (the streaming-end chunk may have been absent) and don't
            // re-emit.
            endStreamedToolCall(toolCallId);
            break;
          }
          // Server tool (or a client tool that emitted no deltas): buffer so a
          // following tool-call-suspended / background-task-started can suppress
          // it and reuse its args, matching the pre-streaming behavior.
          flush();
          pendingToolCall = { toolCallId, toolName, args };
          break;
        }
        case "tool-result": {
          // Swallow the `{ success: true }` result of a working-memory update —
          // its tool-call was mapped to STATE_DELTA and never rendered, so a
          // TOOL_CALL_RESULT here would have no matching call (and is internal
          // plumbing regardless).
          if (workingMemoryToolCalls.has(chunk.payload.toolCallId)) {
            workingMemoryToolCalls.delete(chunk.payload.toolCallId);
            break;
          }
          // For a backgrounded call, the agent loop's inline tool-result is a
          // placeholder ack ("…running in the background; you will be notified
          // when it completes"), NOT the real outcome — the task is detached
          // and its true result is delivered out of band (a later turn / the
          // manager's own stream). So suppress it: don't render a TOOL_CALL_
          // RESULT for a tool call we never rendered, and leave the activity in
          // its "running" state. Real completion arrives via the
          // background-task-completed / -failed chunks handled below.
          if (backgroundToolCalls.has(chunk.payload.toolCallId)) {
            backgroundToolCalls.delete(chunk.payload.toolCallId);
            break;
          }
          flush();
          callbacks.onToolResultPart?.({
            toolCallId: chunk.payload.toolCallId,
            result: chunk.payload.result,
          });
          break;
        }
        case "tool-error": {
          // An inline error on a backgrounded call means dispatch itself failed
          // -> mark the activity failed. Non-background tool errors fall through
          // to the stream's `error` handling elsewhere, so just swallow here.
          const bgError = backgroundToolCalls.get(chunk.payload?.toolCallId);
          if (bgError) {
            backgroundToolCalls.delete(chunk.payload.toolCallId);
            knownTasks.delete(bgError.taskId);
            emitTaskDelta(bgError.taskId, [
              { op: "add", path: "/status", value: "failed" },
              {
                op: "add",
                path: "/error",
                value:
                  chunk.payload?.error?.message ??
                  String(chunk.payload?.error ?? "Unknown error"),
              },
            ]);
          }
          break;
        }
        case "error": {
          const error = new Error(chunk.payload.error as string);
          callbacks.onError(error);
          return true;
        }
        // A2UI progressive streaming (pillar 2): the auto-injected / explicit
        // `generate_a2ui` tool runs its `render_a2ui` subagent via `.stream()`
        // and pushes the render call's arg deltas onto this stream as custom
        // `data-a2ui-render` chunks (see @ag-ui/mastra a2ui-tool renderSubagent).
        // Translate them into synthetic INNER `render_a2ui` TOOL_CALL_* events so
        // the @ag-ui/a2ui-middleware paints the "building" skeleton + fills the
        // surface incrementally instead of bulk-painting the final envelope.
        case "data-a2ui-render": {
          const p = chunk.payload as {
            phase?: string;
            toolCallId?: string;
            toolName?: string;
            argsTextDelta?: string;
          };
          if (!p.toolCallId) break;
          if (p.phase === "start") {
            // Flush the buffered OUTER `generate_a2ui` tool-call onto the wire
            // FIRST, so the A2UIMiddleware has registered it as the active outer
            // call before this inner `render_a2ui` starts. That keys the streamed
            // surface to the outer call, so the final generate_a2ui result
            // envelope lands on the SAME activity id and REPLACES the streamed
            // surface (single paint) instead of duplicating it — and lets the
            // envelope be intercepted (no residual generate_a2ui tool card).
            flush();
            callbacks.onToolCallStart?.({
              toolCallId: p.toolCallId,
              toolName: p.toolName ?? "render_a2ui",
            });
          } else if (p.phase === "delta") {
            if (p.argsTextDelta != null) {
              callbacks.onToolCallArgs?.({
                toolCallId: p.toolCallId,
                argsTextDelta: p.argsTextDelta,
              });
            }
          } else if (p.phase === "end") {
            callbacks.onToolCallEnd?.({ toolCallId: p.toolCallId });
          }
          break;
        }
        case "tool-call-suspended": {
          // Always discard the pending tool-call: if it matches, the tool
          // was suspended before execution; if it doesn't match, the pending
          // call is orphaned (never executed) so emitting TOOL_CALL_START/
          // ARGS/END without a TOOL_CALL_RESULT would violate the protocol.
          pendingToolCall = null;
          if (!chunk.payload.toolCallId || !chunk.payload.toolName) {
            callbacks.onError(
              new Error(
                `Malformed tool-call-suspended: missing toolCallId or toolName in payload`,
              ),
            );
            return true;
          }
          // The turn interrupts here — no `finish` will release the buffer, so
          // emit any assistant text streamed before the suspend (raw; a suspend
          // carries no processor uiMessages) ahead of the interrupt event.
          flushBufferedTextRaw();
          callbacks.onToolSuspended({
            toolCallId: chunk.payload.toolCallId,
            toolName: chunk.payload.toolName,
            suspendPayload: chunk.payload.suspendPayload,
            args: chunk.payload.args,
            resumeSchema: chunk.payload.resumeSchema,
            // Mastra keys the suspended snapshot by the run's id, surfaced on
            // the chunk (`payload.runId`, else the chunk-level `runId`). This
            // can differ from the AG-UI RunAgentInput.runId, so it must be the
            // id resume sends back to `resumeStream`. See the resume path.
            runId: chunk.payload.runId ?? chunk.runId,
          });
          break;
        }
        // Both "finish" and "step-finish" flush any pending tool call and rotate
        // the messageId so the next step's text gets a fresh ID. When a stream
        // ends with step-finish followed by finish, onFinishMessagePart fires
        // twice — the second rotation produces an unused messageId, which is harmless.
        //
        // For useProcessedFinalText, both release buffered/processed text BEFORE
        // rotating the id (so the emitted text inherits the finishing step's
        // messageId), but only the terminal `finish` may fall back to the raw
        // buffer — see releaseBufferedText.
        case "step-finish": {
          flush();
          releaseBufferedText(chunk.payload, false);
          callbacks.onFinishMessagePart?.();
          break;
        }
        case "finish": {
          flush();
          releaseBufferedText(chunk.payload, true);
          callbacks.onFinishMessagePart?.();
          break;
        }
        // Mastra announces the persisted message id for the upcoming step on
        // the start / step-start chunk, before any text streams. Adopt it so
        // the streamed assistant id equals the stored id (see onMessageId).
        case "start":
        case "step-start": {
          // A fresh message window begins: reset the dedup guard so distinct
          // per-step text is never suppressed (see lastEmittedText).
          lastEmittedText = undefined;
          if (chunk.payload?.messageId) {
            callbacks.onMessageId?.(chunk.payload.messageId);
          }
          break;
        }
        // --- Background Tasks (@mastra/core >= 1.29) ---------------------
        // Mastra runs a tool flagged `background: { enabled: true }` out of
        // band; its lifecycle surfaces on fullStream as background-task-*
        // chunks. Map start -> ACTIVITY_SNAPSHOT (full content) and every
        // subsequent lifecycle chunk -> ACTIVITY_DELTA (JSON patch). The task
        // id round-trips as the activity messageId so all events for one task
        // address the same activity message. JSON-patch `add` to an existing
        // object member replaces it (RFC 6902 §4.1), so it is safe for both
        // first-write and updates.
        case "background-task-started": {
          const { taskId, toolName, toolCallId } = chunk.payload;
          // The agent loop emits `tool-call` immediately before this; the
          // bridge has it buffered in pendingToolCall. Suppress that normal
          // tool render (the work is now an activity) but reuse its args for
          // the snapshot. Mirrors the tool-call-suspended suppression.
          const args =
            pendingToolCall && pendingToolCall.toolCallId === toolCallId
              ? pendingToolCall.args
              : undefined;
          pendingToolCall = null;
          if (taskId && toolCallId) {
            backgroundToolCalls.set(toolCallId, { taskId, toolName });
          }
          ensureTaskSnapshot({ taskId, toolName, toolCallId, args });
          break;
        }
        case "background-task-running":
        case "background-task-resumed": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          const status =
            chunk.type === "background-task-resumed" ? "resumed" : "running";
          const patch: Array<Record<string, any>> = [
            { op: "add", path: "/status", value: status },
          ];
          if (p.args !== undefined)
            patch.push({ op: "add", path: "/args", value: p.args });
          if (p.startedAt !== undefined)
            patch.push({
              op: "add",
              path: "/startedAt",
              value: toISO(p.startedAt),
            });
          emitTaskDelta(p.taskId, patch);
          break;
        }
        case "background-task-output": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          // p.payload is a `tool-output` chunk; surface its inner payload (the
          // actual streamed output) and fall back to the whole chunk.
          const output = p.payload?.payload ?? p.payload;
          emitTaskDelta(p.taskId, [
            { op: "add", path: "/status", value: "running" },
            { op: "add", path: "/outputs/-", value: output },
          ]);
          break;
        }
        case "background-task-progress": {
          // Aggregate heartbeat across all running tasks (no per-task id).
          // Tick the elapsed time on each task the client already knows about.
          const p = chunk.payload;
          const taskIds: string[] = Array.isArray(p.taskIds) ? p.taskIds : [];
          for (const taskId of taskIds) {
            if (!knownTasks.has(taskId)) continue;
            emitTaskDelta(taskId, [
              { op: "add", path: "/elapsedMs", value: p.elapsedMs },
            ]);
          }
          break;
        }
        case "background-task-suspended": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          const patch: Array<Record<string, any>> = [
            { op: "add", path: "/status", value: "suspended" },
          ];
          if (p.suspendPayload !== undefined)
            patch.push({
              op: "add",
              path: "/suspendPayload",
              value: p.suspendPayload,
            });
          emitTaskDelta(p.taskId, patch);
          break;
        }
        case "background-task-completed": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          knownTasks.delete(p.taskId);
          backgroundToolCalls.delete(p.toolCallId);
          emitTaskDelta(p.taskId, [
            {
              op: "add",
              path: "/status",
              value: p.isError ? "failed" : "completed",
            },
            { op: "add", path: "/result", value: p.result },
            { op: "add", path: "/completedAt", value: toISO(p.completedAt) },
          ]);
          break;
        }
        case "background-task-failed": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          knownTasks.delete(p.taskId);
          backgroundToolCalls.delete(p.toolCallId);
          emitTaskDelta(p.taskId, [
            { op: "add", path: "/status", value: "failed" },
            {
              op: "add",
              path: "/error",
              value: p.error?.message ?? String(p.error ?? "Unknown error"),
            },
            { op: "add", path: "/completedAt", value: toISO(p.completedAt) },
          ]);
          break;
        }
        case "background-task-cancelled": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          knownTasks.delete(p.taskId);
          backgroundToolCalls.delete(p.toolCallId);
          emitTaskDelta(p.taskId, [
            { op: "add", path: "/status", value: "cancelled" },
            { op: "add", path: "/completedAt", value: toISO(p.completedAt) },
          ]);
          break;
        }
        default: {
          warnOnce(chunk.type, "Unrecognized stream chunk type");
          break;
        }
      }
      return false;
    };

    return { handleChunk, flush };
  }

  /**
   * Processes a Mastra fullStream (async iterable) using createChunkProcessor.
   * @returns true if processing stopped early (error chunk or malformed chunk).
   */
  private async processFullStream(
    stream: AsyncIterable<any>,
    callbacks: MastraAgentStreamOptions,
    clientToolNames: Set<string> = new Set(),
    initialState: Record<string, any> = {},
  ): Promise<boolean> {
    const { handleChunk, flush } = this.createChunkProcessor(
      callbacks,
      clientToolNames,
      initialState,
    );
    for await (const chunk of stream) {
      if (handleChunk(chunk)) return true;
    }
    flush();
    return false;
  }

  /**
   * Returns only the messages Mastra has not already persisted for this thread
   * — the new turn — so we don't re-feed (and re-persist) history Mastra memory
   * already owns. Filters the incoming list against the ids Mastra has stored
   * (recall), mirroring LangGraph's continuation check.
   *
   * Faithful because the bridge streams assistant messages under Mastra's
   * stored id (see onMessageId), so re-sent history matches stored ids and is
   * dropped. Remote agents and agents without memory get the full list (no
   * stored history to dedupe against). Defensive: if filtering would drop
   * everything, or recall fails, forwards the full list.
   */
  private async selectNewMessages(
    threadId: string,
    resourceId: string,
    messages: Message[],
  ): Promise<Message[]> {
    if (!this.isLocalMastraAgent(this.agent)) return messages;
    try {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (!memory) return messages;
      const { messages: stored } = await memory.recall({
        threadId,
        resourceId,
        perPage: false,
      });
      const storedIds = new Set<string>();
      for (const m of (stored ?? []) as Array<{ id?: string }>) {
        if (!m?.id) continue;
        storedIds.add(m.id);
        // The bridge streams assistant text that follows a tool call under a
        // deterministic continuation id derived from the turn's base id (see
        // makeStreamCallbacks). Mastra stores the whole turn under the base id,
        // so the continuation id never appears in recall — treat it as stored
        // here, otherwise the split text is re-sent (and duplicated) each turn.
        storedIds.add(MastraAgent.continuationMessageId(m.id));
      }
      if (storedIds.size === 0) return messages; // first turn / empty thread
      const fresh = messages.filter((m) => !(m.id && storedIds.has(m.id)));
      // Never send an empty turn (a no-op run). If everything was already
      // stored, fall back to forwarding the full list.
      if (fresh.length === 0) return messages;

      // Tool-result tails: a `tool` message must travel with its matching
      // assistant tool-call so the AI SDK resolves call→result into a single
      // message. That assistant message is usually already stored (filtered out
      // above), so re-include it — id-alignment makes Mastra upsert it by id, so
      // no extra row is created. Without this, a lone tool-result leaves the
      // stored call unresolved: Mastra appends a separate result message (a
      // call/result split) and the model re-calls the tool.
      const freshSet = new Set(fresh);
      const neededToolCallIds = new Set(
        fresh
          .filter((m) => m.role === "tool")
          .map((m) => (m as { toolCallId?: string }).toolCallId)
          .filter(Boolean),
      );
      if (neededToolCallIds.size === 0) return fresh;
      const pairedCalls = messages.filter(
        (m) =>
          !freshSet.has(m) &&
          m.role === "assistant" &&
          (m.toolCalls ?? []).some((tc) => neededToolCallIds.has(tc.id)),
      );
      if (pairedCalls.length === 0) return fresh;
      // Preserve original order so each tool-call precedes its result.
      const keep = new Set([...fresh, ...pairedCalls]);
      return messages.filter((m) => keep.has(m));
    } catch (error) {
      console.warn(
        `[MastraAgent] Failed to compute new-message diff for thread ${threadId}; sending full history:`,
        error,
      );
      return messages;
    }
  }

  /**
   * The shared-state slice of a run's input.state: everything except the
   * `messages` list (which the bridge strips before syncing state to working
   * memory). This is what the client holds as its coagent state, so it is the
   * correct base for the first mid-run STATE_DELTA. Returns `{}` when there is
   * no usable state.
   */
  private workingMemoryStateSlice(
    state: RunAgentInput["state"],
  ): Record<string, any> {
    if (!state || typeof state !== "object") return {};
    const { messages, ...rest } = state as Record<string, any>;
    void messages;
    return rest;
  }

  /**
   * Coerces a working-memory value read back from Mastra (a JSON string for
   * schema/json working memory, or already an object, or a `{ workingMemory }`
   * envelope from the remote HTTP route) into a plain object for merging.
   * Returns `{}` for markdown/non-JSON/template ($schema) values.
   */
  private coerceWorkingMemoryObject(raw: unknown): Record<string, any> {
    let value: unknown = raw;
    if (
      value &&
      typeof value === "object" &&
      "workingMemory" in (value as Record<string, unknown>)
    ) {
      value = (value as Record<string, unknown>).workingMemory;
    }
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return {};
      }
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !("$schema" in (value as Record<string, unknown>))
    ) {
      return value as Record<string, any>;
    }
    return {};
  }

  /**
   * Syncs the run's `input.state` (the client's shared state, minus `messages`)
   * into Mastra's resource-scoped working memory BEFORE streaming, so a UI edit
   * reaches the agent on the next run. Merges the client state over the existing
   * working memory: keys the client doesn't manage are preserved, while its
   * shared-state keys (e.g. `recipe`) overwrite wholesale — so a removed value
   * (an unchecked preference) is actually removed, not left lingering.
   *
   * Working memory lives in the RESOURCE store (default scope "resource"),
   * written via `updateWorkingMemory` — NOT `thread.metadata`, which the model
   * never reads. Local agents write through their own `Memory`; remote agents
   * write through the `MastraClient` (`remoteClient`) so the SAME edit reaches a
   * remote server. No-op when there is no client state or (for remote) no client.
   */
  private async syncInputStateToWorkingMemory(
    input: RunAgentInput,
  ): Promise<void> {
    const rest = this.workingMemoryStateSlice(input.state);
    if (Object.keys(rest).length === 0) return;

    const resourceId = this.resourceId ?? input.threadId;
    const memoryConfig = { workingMemory: { enabled: true } };

    if (this.isLocalMastraAgent(this.agent)) {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (!memory) return;

      let existing: Record<string, any> = {};
      try {
        existing = this.coerceWorkingMemoryObject(
          await memory.getWorkingMemory({
            resourceId,
            threadId: input.threadId,
            memoryConfig,
          }),
        );
      } catch {
        // No/invalid existing working memory — start from the client state.
      }

      await memory.updateWorkingMemory({
        resourceId,
        threadId: input.threadId,
        workingMemory: JSON.stringify({ ...existing, ...rest }),
        memoryConfig,
      });
      return;
    }

    // Remote agent: write through the MastraClient (working-memory HTTP route).
    // Requires the client (set by getRemoteAgents) and the agent id.
    if (!this.remoteClient || !this.agentId) return;
    const client = this.remoteClient;
    const agentId = this.agentId;

    let existing: Record<string, any> = {};
    try {
      existing = this.coerceWorkingMemoryObject(
        await client.getWorkingMemory({
          agentId,
          threadId: input.threadId,
          resourceId,
        }),
      );
    } catch {
      // No/invalid (or not-yet-created) working memory — start from client state.
    }

    const workingMemory = JSON.stringify({ ...existing, ...rest });
    const write = () =>
      client.updateWorkingMemory({
        agentId,
        threadId: input.threadId,
        resourceId,
        workingMemory,
      });

    try {
      await write();
    } catch {
      // The remote working-memory HTTP route requires the thread to exist. On
      // the first turn it may not yet (unlike local Memory, which upserts). So
      // create the thread and retry once. Best-effort: if it still fails, skip
      // rather than fail the run — the stream creates the thread, and later
      // turns will sync.
      try {
        await client.createMemoryThread({
          agentId,
          threadId: input.threadId,
          resourceId,
        } as unknown as Parameters<MastraClient["createMemoryThread"]>[0]);
        await write();
      } catch (error) {
        console.warn(
          `[MastraAgent] Failed to sync input.state to remote working memory for thread ${input.threadId}:`,
          error,
        );
      }
    }
  }

  /**
   * Reads the Mastra execution traceId off a consumed stream response, if any.
   *
   * `traceId` is exposed by Mastra observability v-next on the stream response
   * (`MastraModelOutput.traceId`); it may be a plain string or a Promise that
   * resolves after the stream is consumed, so we await a thenable. Probed
   * structurally so the bridge stays compatible with cores / remote clients
   * that don't expose it (they simply yield undefined). Best-effort: a read
   * that throws is swallowed so it never blocks RUN_FINISHED.
   */
  private async resolveTraceId(response: unknown): Promise<string | undefined> {
    if (!response || typeof response !== "object") return undefined;
    try {
      const raw = (response as { traceId?: unknown }).traceId;
      const traceId =
        raw && typeof (raw as PromiseLike<unknown>).then === "function"
          ? await (raw as PromiseLike<unknown>)
          : raw;
      return typeof traceId === "string" && traceId.length > 0
        ? traceId
        : undefined;
    } catch (error) {
      console.warn("[MastraAgent] Failed to read execution traceId:", error);
      return undefined;
    }
  }

  /**
   * Streams a local or remote Mastra agent, emitting AG-UI events via callbacks.
   * For local agents, iterates fullStream with processFullStream.
   * For remote agents, uses processDataStream with createChunkProcessor.
   * Calls onRunFinished on success. For errors, onError is called either from
   * within stream processing (error chunks) or from the catch block (thrown exceptions).
   */
  private async streamMastraAgent(
    {
      threadId,
      runId,
      messages,
      tools,
      context: inputContext,
      forwardedProps,
      state,
    }: RunAgentInput,
    {
      onMessageId,
      onTextPart,
      onReasoningStart,
      onReasoningPart,
      onReasoningEnd,
      onFinishMessagePart,
      onToolCallStart,
      onToolCallArgs,
      onToolCallEnd,
      onToolResultPart,
      onToolSuspended,
      onActivitySnapshot,
      onActivityDelta,
      onStateSnapshot,
      onStateDelta,
      onError,
      onRunFinished,
    }: MastraAgentStreamOptions,
  ): Promise<void> {
    const clientTools = tools.reduce(
      (acc, tool) => {
        acc[tool.name as string] = {
          id: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        };
        return acc;
      },
      {} as Record<string, any>,
    );
    // Names of the frontend tools — only these stream their args live (see
    // createChunkProcessor). Server tools (on the Mastra agent) are absent here.
    const clientToolNames = new Set<string>(
      tools.map((tool) => tool.name as string),
    );
    // Seed shared-state diffing from the state the client already holds (its
    // coagent state, minus the message list the bridge strips before syncing to
    // working memory). The first mid-run STATE_DELTA then patches from what the
    // UI shows, not from empty. See createChunkProcessor.
    const initialState = this.workingMemoryStateSlice(state);
    const resourceId = this.resourceId ?? threadId;

    // AG-UI clients (e.g. CopilotKit) re-send the entire conversation every
    // turn. Mastra memory already owns the thread history, so forwarding the
    // full history re-persists it and balloons storage. Instead we send only
    // the *new* messages: messages whose id Mastra has not already stored.
    // This mirrors LangGraph's continuation check (filter incoming against the
    // checkpoint's message ids) and is faithful because the bridge streams
    // assistant messages under Mastra's stored id (see onMessageId), so re-sent
    // history matches and is filtered out. Mastra still loads full history from
    // memory on read, so the model sees the complete conversation.
    const messagesToSend = await this.selectNewMessages(
      threadId,
      resourceId,
      messages,
    );
    // Convert only the new turn, but resolve tool-message names against the
    // full incoming history (the assistant tool-call may have been filtered
    // out of messagesToSend).
    const convertedMessages = convertAGUIMessagesToMastra(
      messagesToSend,
      messages,
    );
    const requestContext = this.applyInputContext(inputContext);

    if (this.isLocalMastraAgent(this.agent)) {
      try {
        // Auto-inject the backend-owned `generate_a2ui` tool (pillar 1: easy
        // devex) when the runtime/middleware forwarded `injectA2UITool`. The dev
        // wires NO tool; recovery + subagent ride along. Injected per-run as a
        // server toolset so its execute runs in-process (where the loop lives);
        // the middleware-injected `render_a2ui` client tool is dropped so the
        // model calls `generate_a2ui`. Opt out via `injectA2UITool:false`;
        // customize via the `a2ui` config. USER-PREVAILS if the agent already
        // wires `generate_a2ui`. Best-effort: a failure degrades to no A2UI, the
        // turn still runs.
        let a2uiToolsets: Record<string, unknown> | undefined;
        try {
          const existing = await this.agent.listTools({ requestContext });
          const existingToolNames = [
            ...Object.keys(existing ?? {}),
            ...clientToolNames,
          ];
          const plan = planA2UIInjection({
            model:
              this.a2ui?.model ?? (this.agent as { model?: unknown }).model,
            input: {
              forwardedProps,
              context: inputContext,
              messages,
              threadId,
              runId,
            } as RunAgentInput,
            existingToolNames,
            config: this.a2ui,
          });
          if (plan) {
            a2uiToolsets = { a2ui: { [plan.toolName]: plan.tool } };
            for (const drop of plan.dropToolNames) delete clientTools[drop];
          }
        } catch (error) {
          console.warn(
            "[MastraAgent] A2UI auto-injection skipped (continuing without A2UI):",
            error,
          );
        }

        const streamOptions: Record<string, unknown> = {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          runId,
          clientTools,
          requestContext,
          ...(a2uiToolsets ? { toolsets: a2uiToolsets } : {}),
        };
        // Pipe the background-task lifecycle into this run's fullStream (and
        // re-enter the loop on completion) when opted in. Only meaningful for
        // local agents with storage + a memory scope; Mastra falls through to
        // the default stream otherwise.
        if (this.untilIdle) {
          streamOptions.untilIdle = this.untilIdle;
        }
        if (this.tracingOptions) {
          streamOptions.tracingOptions = this.tracingOptions;
        }
        if (this.headers && Object.keys(this.headers).length > 0) {
          streamOptions.modelSettings = {
            ...((streamOptions.modelSettings as
              | Record<string, unknown>
              | undefined) ?? {}),
            headers: this.headers,
          };
        }
        const response = await this.agent.stream(
          convertedMessages,
          streamOptions,
        );

        if (response && typeof response === "object") {
          const hadError = await this.processFullStream(
            response.fullStream,
            {
              onMessageId,
              onTextPart,
              onReasoningStart,
              onReasoningPart,
              onReasoningEnd,
              onFinishMessagePart,
              onToolCallStart,
              onToolCallArgs,
              onToolCallEnd,
              onToolResultPart,
              onToolSuspended,
              onActivitySnapshot,
              onActivityDelta,
              onStateSnapshot,
              onStateDelta,
              onError,
            },
            clientToolNames,
            initialState,
          );

          if (!hadError) {
            const traceId = await this.resolveTraceId(response);
            const usage = await this.resolveUsage(response);
            await onRunFinished?.(traceId, usage);
          }
        } else {
          throw new Error("Invalid response from local agent");
        }
      } catch (error) {
        onError(error as Error);
      }
    } else {
      let stopped = false;
      try {
        const streamOptions: Record<string, unknown> = {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          runId,
          clientTools,
          requestContext,
        };
        if (this.tracingOptions) {
          streamOptions.tracingOptions = this.tracingOptions;
        }
        if (this.headers && Object.keys(this.headers).length > 0) {
          streamOptions.modelSettings = {
            ...((streamOptions.modelSettings as
              | Record<string, unknown>
              | undefined) ?? {}),
            headers: this.headers,
          };
        }
        const response = await this.agent.stream(
          convertedMessages,
          streamOptions,
        );

        // Remote agents use processDataStream (callback-based) — share
        // chunk handling logic via createChunkProcessor.
        if (response && typeof response.processDataStream === "function") {
          const { handleChunk, flush } = this.createChunkProcessor(
            {
              onMessageId,
              onTextPart,
              onReasoningStart,
              onReasoningPart,
              onReasoningEnd,
              onFinishMessagePart,
              onToolCallStart,
              onToolCallArgs,
              onToolCallEnd,
              onToolResultPart,
              onToolSuspended,
              onActivitySnapshot,
              onActivityDelta,
              onStateSnapshot,
              onStateDelta,
              onError,
            },
            clientToolNames,
            initialState,
          );

          await response.processDataStream({
            onChunk: async (chunk: any) => {
              if (stopped) return;
              if (handleChunk(chunk)) stopped = true;
            },
          });
          if (!stopped) flush();
          if (!stopped) {
            const traceId = await this.resolveTraceId(response);
            const usage = await this.resolveUsage(response);
            await onRunFinished?.(traceId, usage);
          }
        } else {
          throw new Error("Invalid response from remote agent");
        }
      } catch (error) {
        if (!stopped) onError(error as Error);
      }
    }
  }

  static async getRemoteAgents(
    options: GetRemoteAgentsOptions,
  ): Promise<Record<string, AbstractAgent>> {
    return getRemoteAgents(options);
  }

  static getLocalAgents(
    options: GetLocalAgentsOptions,
  ): Record<string, AbstractAgent> {
    return getLocalAgents(options);
  }

  static getLocalAgent(options: GetLocalAgentOptions) {
    return getLocalAgent(options);
  }

  static getNetwork(options: GetNetworkOptions) {
    return getNetwork(options);
  }
}
