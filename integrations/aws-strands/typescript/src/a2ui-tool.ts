/**
 * A2UI subagent tool for AWS Strands agents.
 *
 * Thin adapter over `@ag-ui/a2ui-toolkit` — the recovery loop, validation, op
 * builders, prompt assembly and output envelope all live in the toolkit. This
 * file owns only the Strands-specific glue:
 *
 *  - `getA2UITools(params, glue?)` — explicit wiring: builds a Strands tool the
 *    dev adds to their agent's `tools`. The tool runs the toolkit's
 *    validate→retry recovery loop, driving a sub-agent that calls `render_a2ui`.
 *  - `planA2UIInjection(...)` — auto-injection: the pure decision the
 *    adapter makes per run. Reads the runtime `injectA2UITool` flag, infers the
 *    model, resolves the catalog, threads the run's AG-UI messages + state, and
 *    returns the tool to register (+ the injected render tool to drop) — or
 *    `null` when it must not inject.
 *
 * Message shapes: the toolkit expects AG-UI-shaped history (a `render_a2ui`
 * result is a `role:"tool"` message whose `content` is the JSON `a2ui_operations`
 * envelope — this is what `findPriorSurface` walks on an `update`). The Strands
 * SDK uses its own block-structured messages. So the tool keeps BOTH:
 *   - AG-UI messages for the toolkit (`prepareA2UIRequest` / `findPriorSurface`),
 *     supplied by the adapter on auto-injection, else converted from Strands.
 *   - Strands messages for the sub-agent `invoke`, taken from `ctx.agent.messages`
 *     with the in-flight `generate_a2ui` tool call stripped (Bedrock rejects an
 *     assistant `toolUse` with no matching `toolResult`).
 */

import {
  TextBlock,
  ToolResultBlock,
  ToolStreamEvent,
  type Message as StrandsMessage,
  type Model,
  type Tool,
  type ToolContext,
  type ToolStreamGenerator,
} from "@strands-agents/sdk";
import type { Message as AguiMessage, RunAgentInput } from "@ag-ui/core";
import {
  A2UI_OPERATIONS_KEY,
  GENERATE_A2UI_ARG_DESCRIPTIONS,
  GENERATE_A2UI_TOOL_NAME,
  RENDER_A2UI_TOOL_DEF,
  buildA2UIEnvelope,
  prepareA2UIRequest,
  resolveA2UICatalog,
  resolveA2UIToolParams,
  runA2UIGenerationWithRecovery,
  splitA2UISchemaContext,
  wrapErrorEnvelope,
  type A2UIGuidelines,
  type A2UIRecoveryConfig,
  type A2UIToolParams,
  type A2UIValidationCatalog,
} from "@ag-ui/a2ui-toolkit";

import { flattenContentToText } from "./utils";
import { DEFAULT_LOGGER, type Logger } from "./logger";

export type { A2UIToolParams };

/** Default name of the render tool the A2UI middleware injects (and we drop). */
const RENDER_A2UI_TOOL_NAME = RENDER_A2UI_TOOL_DEF.function.name;

/**
 * Marks a `generate_a2ui` tool this adapter auto-injected, so the
 * per-run hook can tell its OWN prior-turn injection (safe to refresh) apart
 * from a `generate_a2ui` the developer wired explicitly (USER PREVAILS,
 * never touched). Without this, the second turn of a cached thread can't
 * distinguish the two and leaks the raw `render_a2ui` tool back to the model.
 */
export const A2UI_AUTOINJECT_MARKER = Symbol.for(
  "@ag-ui/aws-strands.a2uiAutoInjected",
);

/** Tool arguments exposed to the main agent's planner. */
interface GenerateA2UIArgs {
  intent?: "create" | "update";
  target_surface_id?: string;
  changes?: string;
}

/**
 * Marker key on `ToolStreamEvent.data` payloads carrying the sub-agent's
 * render_a2ui streaming progress out of the `generate_a2ui` tool. The adapter
 * (`agent.ts`) translates these into synthetic inner TOOL_CALL_START/ARGS/END
 * events on the AG-UI wire — the shape the a2ui middleware's streaming path
 * needs to drive the "building" skeleton and progressive paint.
 */
export const A2UI_STREAM_KEY = "__a2uiRenderStream";

// Per-process fallback-id sequence: providers that never stamp toolUseId must
// not reuse one id across recovery attempts (Date.now() can collide within a
// millisecond — two full lifecycles under one toolCallId mis-merge in
// id-keyed consumers).
let a2uiRenderSeq = 0;

/** One sub-agent render_a2ui streaming step, re-emitted on the AG-UI wire. */
export interface A2UIRenderStreamEvent {
  kind: "start" | "args" | "end";
  /** The sub-agent's toolUseId — fresh per recovery attempt. */
  toolCallId: string;
  /** Tool name (start only). */
  toolCallName?: string;
  /** Raw args-JSON fragment (args only). */
  delta?: string;
}

/**
 * Per-run glue the adapter threads into the tool. Optional: when omitted
 * (dev-wired), the tool derives AG-UI history from `ctx.agent.messages`
 * and runs with empty state.
 */
export interface A2UIToolGlue {
  /**
   * The run's AG-UI messages (`RunAgentInput.messages`). Used by the toolkit's
   * `findPriorSurface` for `intent:"update"`. When omitted, derived from the
   * Strands conversation.
   */
  aguiMessages?: AguiMessage[];
  /**
   * The run's `RunAgentInput.state`. `buildContextPrompt` reads
   * `state["ag-ui"]` to put available-component context into the sub-agent
   * prompt. When omitted, defaults to `{}`.
   */
  state?: Record<string, unknown>;
}

/**
 * Build a Strands tool that delegates A2UI surface generation to a sub-agent
 * running the toolkit recovery loop. Add the returned tool to a Strands
 * `Agent`'s `tools` list yourself, or let `planA2UIInjection` build it.
 */
export function getA2UITools<TModel = Model>(
  params: A2UIToolParams<TModel>,
  glue: A2UIToolGlue = {},
): Tool {
  if ((params as { model?: unknown })?.model == null) {
    // Type-level enforcement doesn't protect plain-JS callers — and the
    // Strands Agent silently falls back to a default BedrockModel, binding
    // the render sub-agent to an unintended provider.
    throw new Error(
      "getA2UITools requires a 'model' (the Strands model instance the " +
        "render sub-agent runs on).",
    );
  }
  const {
    model,
    guidelines,
    defaultSurfaceId,
    defaultCatalogId,
    toolName,
    toolDescription,
    catalog,
    recovery,
    onA2UIAttempt,
  } = resolveA2UIToolParams(params);
  const subagentModel = model as Model;

  return {
    name: toolName,
    description: toolDescription,
    toolSpec: {
      name: toolName,
      description: toolDescription,
      inputSchema: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: ["create", "update"],
            description: GENERATE_A2UI_ARG_DESCRIPTIONS.intent,
          },
          target_surface_id: {
            type: "string",
            description: GENERATE_A2UI_ARG_DESCRIPTIONS.target_surface_id,
          },
          changes: {
            type: "string",
            description: GENERATE_A2UI_ARG_DESCRIPTIONS.changes,
          },
        },
      },
    },
    async *stream(ctx: ToolContext): ToolStreamGenerator {
      const input = (ctx.toolUse.input ?? {}) as GenerateA2UIArgs;

      // Strands history for the sub-agent invoke, minus the in-flight
      // generate_a2ui call (an unbalanced toolUse is rejected by Bedrock and is
      // for a tool the sub-agent doesn't have).
      const strandsMessages = stripInFlightToolCall(
        (ctx.agent.messages ?? []) as StrandsLikeMessage[],
        toolName,
      );

      // AG-UI history for the toolkit's findPriorSurface (update intent
      // only). MERGE the adapter-supplied glue snapshot (run-start history)
      // with the
      // live Strands-derived results: the snapshot alone misses a surface
      // created EARLIER IN THIS SAME RUN, so a same-run create-then-update
      // would error for a surface visibly on screen. Derived results go
      // last — findPriorSurface walks backwards, so same-run state wins.
      const aguiMessages = [
        ...(glue.aguiMessages ?? []),
        ...strandsToolResultsToAgui(strandsMessages),
      ];

      const prep = prepareA2UIRequest({
        intent: input.intent,
        targetSurfaceId: input.target_surface_id,
        changes: input.changes,
        messages: aguiMessages,
        // `RunAgentInput.state` is `any` on the wire; a truthy non-object
        // must degrade to empty state (mirrors the Python adapter's guard).
        state:
          glue.state && typeof glue.state === "object" && !Array.isArray(glue.state)
            ? glue.state
            : {},
        guidelines,
      });

      // The sub-agent's render_a2ui call must STREAM to the AG-UI wire — the
      // a2ui middleware's "building" skeleton and progressive paint key off the
      // inner tool-call's arg deltas, not the final result (LangGraph gets this
      // for free from nested LLM callbacks; the result-only path falls back to
      // a bulk paint with no lifecycle). The recovery loop runs concurrently as
      // a promise; each sub-agent stream event is queued and re-yielded here as
      // a ToolStreamEvent, which the adapter translates into synthetic inner
      // TOOL_CALL_START/ARGS/END events.
      const queue: A2UIRenderStreamEvent[] = [];
      let notify: (() => void) | null = null;
      const push = (e: A2UIRenderStreamEvent) => {
        queue.push(e);
        notify?.();
        notify = null;
      };

      if (prep.error) {
        // The model still reads the envelope (it can self-correct), but
        // leave a server-side breadcrumb so these are countable.
        DEFAULT_LOGGER.warn(
          `[@ag-ui/aws-strands] A2UI request prep failed: ${prep.error}`,
        );
      }
      // Disconnect channel (mirrors the Python adapter's threading.Event):
      // set when the consumer abandons this generator so the recovery loop
      // stops before firing further sub-agent attempts nobody will drain.
      let disconnected = false;
      const envelopePromise: Promise<string> = prep.error
        ? Promise.resolve(wrapErrorEnvelope(prep.error))
        : runA2UIGenerationWithRecovery({
            basePrompt: prep.prompt,
            catalog,
            config: recovery,
            onAttempt: onA2UIAttempt,
            invokeSubagent: (prompt) => {
              if (disconnected) {
                const abort = new Error(
                  "consumer disconnected; abandoning A2UI recovery",
                );
                abort.name = "CancelledError";
                throw abort;
              }
              return invokeRenderSubagent(subagentModel, prompt, strandsMessages, {
                // Propagate the run's cancellation so an abandoned outer run
                // (client disconnect) doesn't leave the sub-agent's model
                // call running and burning tokens. The signal lives on
                // `ctx.agent.cancelSignal` (LocalAgent), not on the context.
                cancelSignal: (ctx.agent as { cancelSignal?: AbortSignal })
                  .cancelSignal,
                onStreamEvent: push,
                catalogId: defaultCatalogId,
              });
            },
            buildEnvelope: (args) =>
              buildA2UIEnvelope({
                args,
                isUpdate: prep.isUpdate,
                targetSurfaceId: input.target_surface_id,
                prior: prep.prior,
                defaultSurfaceId,
                defaultCatalogId,
              }),
          }).then((r) => r.envelope);

      // Track settlement WITHOUT consuming the rejection (rethrow below).
      let settled = false;
      const settledSignal = envelopePromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      try {
        while (!settled || queue.length > 0) {
          while (queue.length > 0) {
            yield new ToolStreamEvent({
              data: { [A2UI_STREAM_KEY]: queue.shift()! },
            });
          }
          if (settled) break;
          await Promise.race([
            settledSignal,
            new Promise<void>((resolve) => {
              notify = resolve;
            }),
          ]);
        }
      } finally {
        if (!settled) {
          // Generator abandoned mid-drain (executor return()/throw() at a
          // suspended yield): stop the recovery loop before its next attempt,
          // and consume its eventual outcome so a rethrow-class error isn't
          // silently dropped (the settledSignal handler swallows rejections
          // by design — mirror Python's _log_abandoned_recovery_result).
          disconnected = true;
          envelopePromise.catch((err: unknown) => {
            const name = (err as { name?: string })?.name;
            if (name === "CancelledError" || name === "AbortError") return;
            DEFAULT_LOGGER.warn(
              `[@ag-ui/aws-strands] A2UI recovery loop failed after the consumer disconnected: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      }

      const envelope = await envelopePromise;
      return new ToolResultBlock({
        toolUseId: ctx.toolUse.toolUseId,
        status: "success",
        content: [new TextBlock(envelope)],
      });
    },
  };
}

/**
 * Classify a sub-agent invoke error. `"rethrow"` must unwind the tool call —
 * no recovery retries; Strands' tool executor surfaces it as a tool error:
 *   - cancellation (client disconnect) — retrying would defeat the cancel and
 *     burn MORE tokens, the opposite of why the signal is threaded through;
 *   - programmer errors (TypeError/ReferenceError = adapter bugs) — must surface
 *     loudly, not masquerade as a recoverable "failed attempt".
 * `"recoverable"` is a genuine model/network error the recovery loop should
 * record as a failed attempt (retry or tasteful hard-failure).
 */
export function classifyA2UISubagentError(
  err: unknown,
  aborted: boolean,
): "rethrow" | "recoverable" {
  const name = (err as { name?: string })?.name;
  if (aborted || name === "AbortError" || name === "CancelledError") return "rethrow";
  if (err instanceof TypeError) {
    // Node's undici rejects a failed fetch with exactly `TypeError: fetch
    // failed` — the canonical TRANSIENT network error for fetch-based
    // providers, which the recovery loop must absorb. Exact-match only:
    // substring/cause heuristics would misclassify adapter bugs like
    // `this.fetchCatalog is not a function` or any caused TypeError.
    return (err as Error).message === "fetch failed" ? "recoverable" : "rethrow";
  }
  if (err instanceof ReferenceError) return "rethrow";
  return "recoverable";
}

/**
 * Run a SINGLE forced `render_a2ui` model call and return the captured args —
 * or `null` if the model produced no call.
 *
 * Mirrors the LangGraph adapter's single forced structured-output turn
 * (`bind_tools([RENDER_A2UI_TOOL_DEF], tool_choice="render_a2ui")` + one
 * `astream`): we call the model DIRECTLY (not a Strands `Agent`), so there is no
 * agentic loop. The model emits exactly one `render_a2ui` tool call and we stop.
 * A full `Agent` loop would EXECUTE the bound render tool and then fire a SECOND
 * model call to continue the turn — and with the "render the surface" system
 * prompt that continuation re-invokes render (or never settles on a terminal
 * text turn). The sub-agent stream would then never end, so the outer
 * `generate_a2ui` tool never returns its result and the run never emits
 * RUN_FINISHED (the surface paints, but the call hangs). The forced single turn
 * is the fix.
 */
async function invokeRenderSubagent(
  model: Model,
  prompt: string,
  messages: ReadonlyArray<unknown>,
  options: {
    cancelSignal?: AbortSignal;
    /** Called for each render_a2ui streaming step (start / args delta / end). */
    onStreamEvent?: (e: A2UIRenderStreamEvent) => void;
    /**
     * Host-resolved `defaultCatalogId`, stamped into the streamed args. The
     * model never emits `catalogId` (render schema omits it; host owns the
     * catalog), so without this the middleware's progressive paint falls back
     * to the basic catalog and the renderer throws "Catalog not found". The id
     * matches what `buildA2UIEnvelope` stamps on the final surface. Spliced into
     * the EMITTED stream only — the captured args stay the model's own.
     */
    catalogId?: string;
  } = {},
): Promise<Record<string, unknown> | null> {
  const emit = options.onStreamEvent;
  const catalogId = options.catalogId;
  const renderSpec: Tool["toolSpec"] = {
    name: RENDER_A2UI_TOOL_NAME,
    description: RENDER_A2UI_TOOL_DEF.function.description,
    inputSchema: RENDER_A2UI_TOOL_DEF.function
      .parameters as Tool["toolSpec"]["inputSchema"],
  };

  let captured: Record<string, unknown> | null = null;
  let accumulated = "";
  // Tracks the in-flight render_a2ui block between toolUseStart and blockStop.
  let liveRenderCallId: string | null = null;
  // Whether the host catalog id has been spliced into the streamed args for
  // the current call yet (reset per render start).
  let catalogPrefixed = false;

  const finishCall = () => {
    // The model streams render_a2ui's args as a JSON string (partial fragments
    // reconstruct into the full object). Parse the accumulated RAW string — not
    // the catalog-spliced stream — so the committed args are the model's own
    // (catalogId is stamped by buildA2UIEnvelope).
    try {
      captured = accumulated.trim()
        ? (JSON.parse(accumulated) as Record<string, unknown>)
        : {};
    } catch {
      captured = {};
    }
  };

  const aborted = () => !!options.cancelSignal?.aborted;
  const abortError = () => {
    const e = new Error("consumer disconnected; abandoning A2UI render");
    e.name = "AbortError";
    return e;
  };

  try {
    if (aborted()) throw abortError();
    // Stream the MODEL directly (no Agent loop, no tool execution) so the
    // render_a2ui arg deltas surface live for the middleware's progressive
    // paint while guaranteeing a single forced turn.
    const gen = model.stream(messages as unknown as StrandsMessage[], {
      systemPrompt: prompt,
      toolSpecs: [renderSpec],
      toolChoice: { tool: { name: RENDER_A2UI_TOOL_NAME } },
    });
    for await (const ev of gen) {
      // `model.stream` yields raw model events directly (no
      // `modelStreamUpdateEvent` wrapper, unlike `Agent.stream`).
      // Cooperative cancellation: `model.stream` has no cancelSignal option, so
      // bail between events when the outer run is abandoned.
      if (aborted()) throw abortError();
      const e = ev as {
        type?: string;
        start?: { type?: string; toolUseId?: string; name?: string };
        delta?: { type?: string; input?: string };
      };
      if (
        e?.type === "modelContentBlockStartEvent" &&
        e.start?.type === "toolUseStart"
      ) {
        // ANY new tool block closes a still-open render call first (a missing
        // blockStop must not leave an unclosed inner TOOL_CALL_START on the
        // wire, and a foreign tool's arg deltas must never attribute to it).
        if (liveRenderCallId) {
          emit?.({ kind: "end", toolCallId: liveRenderCallId });
          liveRenderCallId = null;
        }
        if (e.start.name !== RENDER_A2UI_TOOL_NAME) continue;
        // `||` (not `??`): an empty-string toolUseId must take the fallback —
        // a falsy live id would disable every close/delta guard below.
        liveRenderCallId = e.start.toolUseId || `a2ui-render-${++a2uiRenderSeq}`;
        accumulated = "";
        catalogPrefixed = false;
        emit?.({
          kind: "start",
          toolCallId: liveRenderCallId,
          toolCallName: RENDER_A2UI_TOOL_NAME,
        });
      } else if (
        liveRenderCallId &&
        e?.type === "modelContentBlockDeltaEvent" &&
        e.delta?.type === "toolUseInputDelta" &&
        typeof e.delta.input === "string"
      ) {
        let delta = e.delta.input;
        accumulated += delta;
        // Stamp the host catalog id into the FIRST chunk by splicing it right
        // after the opening brace, so the accumulated args become
        // `{"catalogId": "<id>", ...}` — valid JSON the middleware's progressive
        // paint reads the id from. The model never emits catalogId itself.
        if (catalogId && !catalogPrefixed) {
          const brace = delta.indexOf("{");
          if (brace !== -1) {
            delta =
              delta.slice(0, brace + 1) +
              `"catalogId": ${JSON.stringify(catalogId)}, ` +
              delta.slice(brace + 1);
            catalogPrefixed = true;
          }
        }
        emit?.({ kind: "args", toolCallId: liveRenderCallId, delta });
      } else if (liveRenderCallId && e?.type === "modelContentBlockStopEvent") {
        emit?.({ kind: "end", toolCallId: liveRenderCallId });
        finishCall();
        liveRenderCallId = null;
        // Single forced turn: the render call is complete. Stop the stream so
        // no continuation model call ever fires.
        break;
      }
    }
  } catch (err) {
    if (liveRenderCallId) {
      // The provider stream died mid-call: close the live synthetic call
      // before unwinding — an unclosed inner TOOL_CALL_START is a
      // wire-protocol violation, and the next recovery attempt would open a
      // fresh call on top of it.
      emit?.({ kind: "end", toolCallId: liveRenderCallId });
      liveRenderCallId = null;
    }
    if (classifyA2UISubagentError(err, aborted()) === "rethrow") {
      throw err;
    }
    // A genuine model/network error must not crash the whole turn — the recovery
    // design guarantees the conversation stays usable. Log it (fail-loud) and
    // return null so the loop records a failed attempt and retries or emits the
    // tasteful hard-failure envelope.
    DEFAULT_LOGGER.warn(
      `[@ag-ui/aws-strands] A2UI sub-agent invoke failed; treating as a failed attempt: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (liveRenderCallId) {
    // Stream ended without a blockStop for the live call — close + capture.
    emit?.({ kind: "end", toolCallId: liveRenderCallId });
    finishCall();
    liveRenderCallId = null;
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Message-shape helpers
// ---------------------------------------------------------------------------

/** Minimal structural view of a Strands message (role + content blocks). */
interface StrandsLikeMessage {
  role?: string;
  content?: unknown;
}

/**
 * Extract a toolUse `{ name }` from a Strands content block, handling both the
 * class-instance form (`ToolUseBlock`, `type:"toolUseBlock"`, `name` on the
 * block) and the serialized wrapped-data form (`{ toolUse: { name } }`).
 */
function readToolUse(block: unknown): { name?: string } | null {
  const b = block as { type?: string; name?: string; toolUse?: { name?: string } };
  if (b?.type === "toolUseBlock") return { name: b.name };
  if (b?.toolUse) return { name: b.toolUse.name };
  return null;
}

/**
 * Extract a toolResult `{ toolUseId, content }` from a Strands content block,
 * handling the class-instance form (`ToolResultBlock`, `type:"toolResultBlock"`)
 * and the serialized wrapped-data form (`{ toolResult: { ... } }`).
 */
function readToolResult(
  block: unknown,
): { toolUseId?: string; content?: unknown } | null {
  const b = block as {
    type?: string;
    toolUseId?: string;
    content?: unknown;
    toolResult?: { toolUseId?: string; content?: unknown };
  };
  if (b?.type === "toolResultBlock")
    return { toolUseId: b.toolUseId, content: b.content };
  if (b?.toolResult) return b.toolResult;
  return null;
}

/** Returns true if a message's content holds a toolUse block for `toolName`. */
function hasToolUseFor(message: StrandsLikeMessage, toolName: string): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => readToolUse(block)?.name === toolName);
}

/**
 * Drop the trailing in-flight `toolName` call. When the model invokes the
 * generate tool, the assistant turn carrying that `toolUse` is the last message
 * and has no matching `toolResult` yet — passing it to the sub-agent (which
 * lacks the tool) is malformed. Only strips when the LAST message is that call,
 * so a normal user turn at the tail is preserved.
 */
export function stripInFlightToolCall<T extends StrandsLikeMessage>(
  messages: T[],
  toolName: string,
): T[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && hasToolUseFor(last, toolName)) {
    return messages.slice(0, -1);
  }
  // Copy in the no-strip branch too — the input is live agent state
  // (`ctx.agent.messages`); returning it by reference invites accidental
  // mutation of the agent's history.
  return messages.slice();
}

/**
 * Reconstruct the AG-UI `role:"tool"` messages the toolkit's `findPriorSurface`
 * needs (used only for `intent:"update"`) from Strands history. Strands carries
 * tool results as `toolResult` blocks (typically nested in user turns); we emit
 * one AG-UI tool message per result whose content is the result text — i.e. the
 * prior `a2ui_operations` envelope JSON string when the result was an A2UI
 * render. Non-result content is ignored; this is intentionally narrow because
 * `findPriorSurface` only inspects `role:"tool"` JSON-string content.
 */
/**
 * Extract text from a Strands `toolResult.content` for A2UI detection. Robust to
 * every shape the SDK produces: a raw string; class-instance blocks
 * (`{ type:"textBlock", text }` / `{ type:"jsonBlock", json }`); and the
 * SERIALIZED data form, which is a bare `{ text }` / `{ json }` with NO `type`
 * discriminant (what `_buildStrandsHistory` emits and `fromMessageData` carries).
 * `flattenContentToText` only handles the `type`-tagged text forms, so relying
 * on it alone silently misses prior surfaces in dev-wired update history.
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return flattenContentToText(content);
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown; json?: unknown };
    if (typeof b?.text === "string") parts.push(b.text);
    else if (b?.json !== undefined) parts.push(JSON.stringify(b.json));
  }
  return parts.join("");
}

export function strandsToolResultsToAgui(
  messages: StrandsLikeMessage[],
): AguiMessage[] {
  const out: AguiMessage[] = [];
  let fallbackSeq = 0;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const result = readToolResult(block);
      if (!result) continue;
      const text = extractToolResultText(result.content);
      if (!text || !text.includes(A2UI_OPERATIONS_KEY)) continue;
      // Unique fallback id per result so two id-less prior results don't alias.
      // `||` (not `??`): empty-string ids must also take the unique fallback.
      const id = result.toolUseId || `a2ui-prior-${fallbackSeq++}`;
      out.push({
        id,
        role: "tool",
        toolCallId: id,
        content: text,
      } as AguiMessage);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-inject decision
// ---------------------------------------------------------------------------

/** Backend override knobs (mirrors the runtime `injectA2UITool` flag). */
export interface A2UIInjectConfig {
  /**
   * Inject `generate_a2ui` regardless of the runtime flag (for non-CopilotKit
   * hosts). `true` uses the default tool name; a string also sets the name of
   * the injected render tool to drop.
   */
  injectA2UITool?: boolean | string;
  /** Inline catalog forwarded to the recovery loop (overrides context). */
  catalog?: A2UIValidationCatalog;
  /**
   * Catalog id stamped into every `createSurface` op. Must match the catalog
   * the host's renderer registered (e.g. the dojo's dynamic catalog), otherwise
   * the renderer can't resolve the surface's components. Mirrors LangGraph's
   * `getA2UITools({ defaultCatalogId })`. Falls back to the toolkit's basic
   * catalog when unset.
   */
  defaultCatalogId?: string;
  /**
   * Generation/design/composition prompt knobs forwarded to the sub-agent. Set
   * `guidelines.compositionGuide` to teach the sub-agent the host catalog's
   * components (names + props) — required for a real model to compose them,
   * mirroring LangGraph's `getA2UITools({ guidelines })`.
   */
  guidelines?: A2UIGuidelines;
  /**
   * Recovery loop config (attempt cap, retry-UI threshold) for the
   * auto-injected tool. Defaults to the toolkit's `MAX_A2UI_ATTEMPTS` (3).
   */
  recovery?: A2UIRecoveryConfig;
}

/** The injection decision: what to register and what to drop. */
export interface A2UIInjectionPlan {
  /** The `generate_a2ui` tool to register on the agent. */
  tool: Tool;
  /** Name the tool is registered under. */
  toolName: string;
  /** Injected render-tool names to drop so the model calls `generate_a2ui`. */
  dropToolNames: string[];
  /** Catalog resolved from context / config, passed to the recovery loop. */
  catalog?: A2UIValidationCatalog;
}

export interface PlanA2UIInjectionInput<TModel = Model> {
  /** Model inferred from the wrapped agent (`null` for orchestrators). */
  model: TModel | null | undefined;
  /** The run input — read for `forwardedProps.injectA2UITool`, messages, state, catalog context. */
  input: RunAgentInput;
  /** Tool names already on the agent (user-prevails dedup). */
  existingToolNames: string[];
  /** Backend override config. */
  config?: A2UIInjectConfig;
  /** Logger for the orchestrator skip warning (only `warn` is used). */
  log?: Pick<Logger, "warn">;
}

/**
 * Decide whether to auto-inject `generate_a2ui` for this run, mirroring the
 * LangGraph contract ("no injectA2UITool, no injection"):
 *
 *  1. Off unless the runtime forwarded `injectA2UITool` (`true`, or a string
 *     naming the injected RENDER tool to drop) OR a backend
 *     `config.injectA2UITool` override is set.
 *  2. USER PREVAILS — if the dev already wired `generate_a2ui`, do not
 *     double-inject. (The per-run hook removes our OWN marked tool before
 *     computing `existingToolNames`, so this only catches a dev-wired tool.)
 *     Deliberately, NOTHING else is touched in this branch: the dev opted out
 *     of adapter management, so any runtime-injected render tool stays too.
 *     Limitation: the check is name-based — a dev-wired tool under a custom
 *     `toolName` is not recognized and auto-injection proceeds alongside it.
 *  3. No inferable model (Graph/Swarm orchestrators) → warn + skip.
 *  4. Otherwise build the tool (threading the run's AG-UI messages + state +
 *     guidelines), resolve the catalog, and drop the injected render tool.
 */
export function planA2UIInjection<TModel = Model>(
  args: PlanA2UIInjectionInput<TModel>,
): A2UIInjectionPlan | null {
  const { input, existingToolNames, config, log = DEFAULT_LOGGER } = args;

  const forwarded = input.forwardedProps as
    | { injectA2UITool?: boolean | string }
    | undefined;
  const flag = forwarded?.injectA2UITool ?? config?.injectA2UITool;
  if (!flag) return null;

  const toolName = GENERATE_A2UI_TOOL_NAME;
  // USER PREVAILS: explicit dev wiring wins — never double-inject.
  if (existingToolNames.includes(toolName)) return null;

  if (args.model == null) {
    log.warn(
      "[@ag-ui/aws-strands] A2UI tool injection requested but no model could be " +
        "inferred from the agent (multi-agent orchestrators like Graph/Swarm have " +
        "no `.model`). Skipping auto-injection — wire getA2UITools() explicitly.",
    );
    return null;
  }

  const renderToolName = typeof flag === "string" ? flag : RENDER_A2UI_TOOL_NAME;

  // Lift the A2UI schema + remaining context under state["ag-ui"] so the
  // sub-agent prompt carries the component schema + context, same as the
  // LangGraph adapter routes context into graph state. Uses the shared toolkit
  // split so both adapters agree on the schema-context description.
  const [schemaValue, regularContext] = splitA2UISchemaContext(
    input.context as Array<Record<string, unknown>> | undefined,
  );
  const baseState: Record<string, unknown> =
    input.state && typeof input.state === "object" && !Array.isArray(input.state)
      ? { ...(input.state as Record<string, unknown>) }
      : {};
  const agUi: Record<string, unknown> = { context: regularContext };
  if (schemaValue !== undefined) agUi.a2ui_schema = schemaValue;
  baseState["ag-ui"] = agUi;

  // Resolve the frontend-registered catalog from run state (native a2ui_schema
  // or an "A2UI catalog" context entry) so surfaces bind to the host's catalog
  // without the host hardcoding it. Backend config WINS when set.
  const resolved = resolveA2UICatalog(baseState);
  const [runtimeSchema, runtimeCatalogId] = resolved ?? [undefined, undefined];

  // Explicit `config.catalog` still feeds the semantic-validation catalog;
  // recovery stays structural-only when absent (the catalog is never
  // auto-resolved from context for VALIDATION, only the id/guide below).
  const catalog = config?.catalog;
  const defaultCatalogId = config?.defaultCatalogId ?? runtimeCatalogId;
  let guidelines = config?.guidelines;
  if (guidelines === undefined && runtimeSchema !== undefined) {
    guidelines = { compositionGuide: runtimeSchema };
  }

  const tool = getA2UITools(
    {
      model: args.model as unknown as Model,
      toolName,
      catalog,
      defaultCatalogId,
      guidelines,
      recovery: config?.recovery,
    },
    { aguiMessages: input.messages as AguiMessage[], state: baseState },
  );
  // Tag as ours so the per-run hook can refresh (not "user-prevails") it.
  (tool as { [A2UI_AUTOINJECT_MARKER]?: true })[A2UI_AUTOINJECT_MARKER] = true;

  return { tool, toolName, dropToolNames: [renderToolName], catalog };
}

/** True if `tool` is a `generate_a2ui` this adapter auto-injected. */
export function isAutoInjectedA2UITool(tool: unknown): boolean {
  return (
    typeof tool === "object" &&
    tool !== null &&
    (tool as { [A2UI_AUTOINJECT_MARKER]?: boolean })[A2UI_AUTOINJECT_MARKER] ===
      true
  );
}
