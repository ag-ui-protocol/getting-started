/**
 * A2UI subagent tool factory for Mastra agents.
 *
 * Thin adapter over ``@ag-ui/a2ui-toolkit`` — the heavy lifting (op builders,
 * prompt assembly, history walkers, output envelope, and the validate→retry
 * recovery loop) lives in the toolkit so this adapter owns ONLY the Mastra
 * glue: the ``createTool`` decorator, reading the run's messages/context off the
 * tool-execution context, and driving the ``render_a2ui`` structured-output
 * subagent through an ephemeral Mastra ``Agent`` (so model resolution matches
 * the host and the package never couples to a specific ``ai`` version).
 *
 * This is the Mastra sibling of ``getA2UITools`` in ``@ag-ui/langgraph`` and
 * ``@ag-ui/aws-strands`` — same ``A2UIToolParams`` shape, same recovery loop,
 * same envelope. It is the BACKEND-OWNED path: the developer adds the returned
 * tool to their Mastra agent's tools and wires the copilotkit route (or an
 * ``A2UIMiddleware`` direct attach) with ``injectA2UITool: false`` so the
 * runtime renders the surface WITHOUT also injecting its own ``generate_a2ui``
 * (double-bind). Recovery is never in the CopilotKit runtime — it runs here.
 *
 * Example:
 *
 *   import { getA2UITools } from "@ag-ui/mastra";
 *   import { openai } from "@ai-sdk/openai";
 *   import { Agent } from "@mastra/core/agent";
 *
 *   const generateA2ui = getA2UITools({
 *     model: "openai/gpt-4.1", // or an AI SDK model object
 *     defaultCatalogId: "my-catalog",
 *     recovery: { maxAttempts: 3 },
 *   });
 *
 *   const agent = new Agent({ ..., tools: { generate_a2ui: generateA2ui } });
 *
 * The four pillars, matching langgraph/strands/adk:
 *  1. AUTO-INJECT (easy devex): the MastraAgent bridge injects this tool per run
 *     via ``planA2UIInjection`` when the runtime forwards ``injectA2UITool`` — the
 *     dev wires nothing. Opt out with ``injectA2UITool:false``; customize via the
 *     ``a2ui`` config. (Explicit ``getA2UITools`` is the opt-out / remote path.)
 *  2. PROGRESSIVE STREAMING: the subagent runs via ``.stream()`` and its
 *     ``render_a2ui`` arg deltas are pushed onto the outer agent stream (Mastra
 *     ``writer.custom``); the bridge translates them to inner TOOL_CALL_* so the
 *     surface paints incrementally (see ``renderSubagent``).
 *  3. ERROR RECOVERY: the toolkit's validate→retry loop; invalid never paints,
 *     exhaustion → a tasteful failure envelope.
 *  4. SUBAGENT-BASED: a ``render_a2ui`` structured-output subagent.
 *
 * (Server-side / REMOTE Mastra agents import from ``@ag-ui/mastra/a2ui`` — a
 * bridge-free entry that omits the AbstractAgent bridge so the Mastra CLI bundler
 * needn't resolve its transitive deps.)
 */

import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { RunAgentInput } from "@ag-ui/client";
import {
  GENERATE_A2UI_TOOL_NAME,
  GENERATE_A2UI_ARG_DESCRIPTIONS,
  RENDER_A2UI_TOOL_DEF,
  buildA2UIEnvelope,
  prepareA2UIRequest,
  resolveA2UICatalog,
  resolveA2UIToolParams,
  splitA2UISchemaContext,
  wrapErrorEnvelope,
  runA2UIGenerationWithRecovery,
  type A2UIGuidelines,
  type A2UIToolParams,
  type A2UIAttemptRecord,
  type A2UIRecoveryConfig,
  type A2UIValidationCatalog,
} from "@ag-ui/a2ui-toolkit";

/** Name of the render tool the subagent is forced to call. */
const RENDER_A2UI_TOOL_NAME = RENDER_A2UI_TOOL_DEF.function.name;

/**
 * Loose type for the subagent model. Typed as ``any`` so the factory accepts any
 * Mastra-compatible model config — a provider-string like ``"openai/gpt-4.1"``
 * (resolved by Mastra's own model router, the idiomatic Mastra form) OR an AI SDK
 * model object (``openai("gpt-4.1")``). Running the subagent through a Mastra
 * ``Agent`` (below) means the package never imports ``ai`` directly, so it is
 * immune to consumer ``ai`` / ``@ai-sdk/*`` major-version skew.
 */
export type A2UISubagentModel = any;

export type { A2UIToolParams, A2UIAttemptRecord, A2UIRecoveryConfig };

/**
 * Minimal structural view of the pieces of Mastra's ``ToolExecutionContext``
 * this adapter reads. Typed locally (not imported from ``@mastra/core``) so the
 * adapter tolerates @mastra/core version skew — the fields below are stable
 * across the supported 1.x range.
 */
interface A2UIToolExecutionContext {
  /** Per-run agent context. ``messages`` is the conversation the loop is on. */
  agent?: { messages?: unknown[] };
  /**
   * Mastra request context. The AG-UI Mastra bridge forwards
   * ``RunAgentInput.context`` (which carries the A2UI catalog schema entry the
   * ``@ag-ui/a2ui-middleware`` / provider injects) under the ``"ag-ui"`` key.
   */
  requestContext?: { get?: (key: string) => unknown };
  /** Mastra ToolStream — used to push progressive render deltas (pillar 2). */
  writer?: A2UIStreamWriter;
}

/** Outer tool arguments exposed to the main Mastra agent's planner. */
const generateA2UIInputSchema = z.object({
  intent: z
    .enum(["create", "update"])
    .optional()
    .describe(GENERATE_A2UI_ARG_DESCRIPTIONS.intent),
  target_surface_id: z
    .string()
    .optional()
    .describe(GENERATE_A2UI_ARG_DESCRIPTIONS.target_surface_id),
  changes: z
    .string()
    .optional()
    .describe(GENERATE_A2UI_ARG_DESCRIPTIONS.changes),
});

/** Zod mirror of ``RENDER_A2UI_TOOL_DEF`` for the forced subagent tool call. */
const renderA2UIInputSchema = z.object({
  surfaceId: z.string().describe("Unique surface identifier."),
  components: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      "A2UI v0.9 component array (flat format); root component id 'root'.",
    ),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional initial data model for the surface."),
});

/**
 * Read the AG-UI context array the bridge forwarded onto Mastra's request
 * context. Defensive: any shape other than the expected ``{ context: [...] }``
 * degrades to an empty list (no catalog → the subagent falls back to the
 * configured ``defaultCatalogId``), never throws.
 */
function readAgUiContext(
  requestContext: A2UIToolExecutionContext["requestContext"],
): Array<Record<string, unknown>> {
  const entry =
    typeof requestContext?.get === "function"
      ? requestContext.get("ag-ui")
      : undefined;
  const context = (entry as { context?: unknown } | undefined)?.context;
  return Array.isArray(context)
    ? (context as Array<Record<string, unknown>>)
    : [];
}

/**
 * Drop a trailing in-flight ``generate_a2ui`` assistant tool-call from history
 * before the subagent runs — it is unbalanced (no result yet) and would only
 * confuse the render subagent. Mirrors LangGraph's ``slice(0, -1)`` but is
 * guarded so it only strips when the last message actually is that call.
 */
function stripInFlightGenerateCall(
  messages: unknown[],
  toolName: string,
): unknown[] {
  const last = messages[messages.length - 1] as
    | { role?: string; toolCalls?: Array<{ function?: { name?: string } }> }
    | undefined;
  const calls = last?.toolCalls;
  if (
    last?.role === "assistant" &&
    Array.isArray(calls) &&
    calls.some((c) => c?.function?.name === toolName)
  ) {
    return messages.slice(0, -1);
  }
  return messages;
}

/** Coerce one message's content to plain text for the subagent prompt. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Map the run's messages to the ``{ role, content }`` shape ``generateText``
 * accepts. System/tool roles collapse to ``user`` (the subagent only needs the
 * conversational request as context; it is forced to call ``render_a2ui``).
 */
function toModelMessages(
  messages: unknown[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .map((m) => {
      const msg = m as { role?: unknown; content?: unknown };
      const role = msg.role === "assistant" ? "assistant" : "user";
      return {
        role: role as "user" | "assistant",
        content: messageText(msg.content),
      };
    })
    .filter((m) => m.content.length > 0);
}

/** AG-UI render-stream chunk type the tool writes onto the outer agent stream
 *  (via Mastra `ToolStream.custom`); the bridge's createChunkProcessor
 *  translates it into synthetic inner render_a2ui TOOL_CALL_* events. */
export const A2UI_RENDER_STREAM_TYPE = "data-a2ui-render";

/** Minimal writer surface (Mastra `ToolStream`) — only `custom` is used. */
interface A2UIStreamWriter {
  custom?: (chunk: {
    type: string;
    payload: Record<string, unknown>;
  }) => Promise<void> | void;
}

/**
 * Run the ``render_a2ui`` structured-output subagent once and return its args
 * (``{ surfaceId, components, data }``) — or ``null`` if the model produced no
 * tool call. The recovery loop calls this once per attempt with an
 * error-augmented ``prompt``.
 *
 * The subagent is an ephemeral Mastra ``Agent`` bound to a CAPTURING
 * ``render_a2ui`` tool: forcing ``toolChoice: "required"`` with ``maxSteps: 1``
 * makes the model emit exactly one structured render call, whose args the tool's
 * ``execute`` captures. Running through Mastra (rather than a raw ``ai``
 * ``generateText``) resolves the model the way the host agent does and never
 * couples to a specific ``ai`` / ``@ai-sdk/*`` version.
 *
 * PROGRESSIVE STREAMING (pillar 2): the subagent runs via ``.stream()`` and its
 * ``render_a2ui`` tool-call arg deltas are pushed onto the OUTER agent stream via
 * ``writer.custom({type:"data-a2ui-render", ...})``. The bridge translates those
 * into inner ``TOOL_CALL_START/ARGS/END`` so the A2UIMiddleware paints the
 * "building" skeleton + fills the surface incrementally. A fresh call id per
 * attempt keeps the middleware's retry lifecycle correct; the live call is
 * always closed (end phase) even on error so the wire stays balanced.
 */
async function renderSubagent(
  model: A2UISubagentModel,
  prompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  writer: A2UIStreamWriter | undefined,
  attempt: number,
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;

  const renderTool = createTool({
    id: RENDER_A2UI_TOOL_NAME,
    description: RENDER_A2UI_TOOL_DEF.function.description,
    inputSchema: renderA2UIInputSchema,
    execute: async (input) => {
      captured = input as Record<string, unknown>;
      return "ok";
    },
  });

  const subagent = new Agent({
    id: "a2ui_render_subagent",
    name: "a2ui_render_subagent",
    instructions: prompt,
    model,
    tools: { [RENDER_A2UI_TOOL_NAME]: renderTool },
  });

  // Fresh render call id per attempt so the middleware treats each attempt as a
  // distinct render (building -> retrying -> painted / failed).
  const callId = `a2ui-render-${attempt}-${RENDER_A2UI_TOOL_NAME}`;
  let liveOpen = false;
  const push = async (payload: Record<string, unknown>) => {
    if (writer?.custom) {
      await writer.custom({ type: A2UI_RENDER_STREAM_TYPE, payload });
    }
  };
  const openLive = async () => {
    if (liveOpen) return;
    liveOpen = true;
    await push({
      phase: "start",
      toolCallId: callId,
      toolName: RENDER_A2UI_TOOL_NAME,
    });
  };
  const closeLive = async () => {
    if (!liveOpen) return;
    liveOpen = false;
    await push({ phase: "end", toolCallId: callId });
  };

  try {
    const res: any = await subagent.stream(
      messages as any,
      {
        toolChoice: "required",
        maxSteps: 1,
      } as any,
    );
    for await (const chunk of res.fullStream) {
      const p = (chunk?.payload ?? {}) as Record<string, any>;
      switch (chunk?.type) {
        case "tool-call-input-streaming-start": {
          if (p.toolName === RENDER_A2UI_TOOL_NAME) await openLive();
          break;
        }
        case "tool-call-delta": {
          if (p.argsTextDelta != null) {
            await openLive();
            await push({
              phase: "delta",
              toolCallId: callId,
              argsTextDelta: String(p.argsTextDelta),
            });
          }
          break;
        }
        case "tool-call-input-streaming-end":
        case "tool-call": {
          await closeLive();
          break;
        }
        default:
          break;
      }
    }
  } finally {
    // Balance the wire even if the stream ended without an end chunk or threw.
    await closeLive();
  }

  return captured;
}

/**
 * Build a Mastra tool that delegates A2UI surface generation to a subagent,
 * with the shared validate→retry recovery loop. Add the returned tool to a
 * Mastra agent's ``tools`` map (conventionally under the key ``generate_a2ui``).
 *
 * @param params Shared ``A2UIToolParams`` (model + behavior knobs). The toolkit
 *   owns the shape and fills defaults via ``resolveA2UIToolParams``.
 */
export function getA2UITools<TModel = A2UISubagentModel>(
  params: A2UIToolParams<TModel>,
) {
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
  const subagentModel = model as A2UISubagentModel;

  return createTool({
    id: toolName,
    description: toolDescription,
    inputSchema: generateA2UIInputSchema,
    // Returns the a2ui_operations / recovery-failure envelope as a PARSED
    // OBJECT (not the toolkit's JSON string). The Mastra bridge JSON.stringifies
    // a tool result once for the wire; returning an object yields SINGLE-encoded
    // TOOL_CALL_RESULT content, which is what the A2UIMiddleware's envelope +
    // recovery-failure detectors expect (a string result would be double-encoded
    // and the failure path — unlike the ops path — would miss it).
    execute: async (input, context): Promise<unknown> => {
      const ctx = (context ?? {}) as A2UIToolExecutionContext;
      const allMessages = Array.isArray(ctx.agent?.messages)
        ? (ctx.agent!.messages as unknown[])
        : [];
      const messages = stripInFlightGenerateCall(allMessages, toolName);

      // The bridge forwards RunAgentInput.context (with the A2UI catalog schema
      // entry) onto Mastra's request context. Split out the schema entry into
      // the canonical ``state["ag-ui"]`` shape the toolkit's prompt builder and
      // catalog resolver expect.
      const [schemaValue, regularContext] = splitA2UISchemaContext(
        readAgUiContext(ctx.requestContext),
      );
      const state: Record<string, unknown> = {
        "ag-ui": { a2ui_schema: schemaValue, context: regularContext },
      };

      // Shared: create/update decision, prior-surface lookup, prompt assembly.
      const prep = prepareA2UIRequest({
        intent: input.intent,
        targetSurfaceId: input.target_surface_id,
        changes: input.changes,
        messages,
        state,
        guidelines,
      });
      if (prep.error) return parseEnvelope(wrapErrorEnvelope(prep.error));

      const modelMessages = toModelMessages(messages);

      // Shared: validate→retry loop. Invalid surfaces never paint (the
      // middleware gate uses the same validator); exhaustion returns a
      // structured ``a2ui_recovery_exhausted`` envelope so the conversation
      // stays usable.
      const { envelope } = await runA2UIGenerationWithRecovery({
        basePrompt: prep.prompt,
        catalog,
        config: recovery,
        onAttempt: onA2UIAttempt,
        invokeSubagent: (prompt, attempt) =>
          renderSubagent(
            subagentModel,
            prompt,
            modelMessages,
            ctx.writer,
            attempt,
          ),
        buildEnvelope: (args) =>
          buildA2UIEnvelope({
            args,
            isUpdate: prep.isUpdate,
            targetSurfaceId: input.target_surface_id,
            prior: prep.prior,
            defaultSurfaceId,
            defaultCatalogId,
          }),
      });
      // Always return the real a2ui_operations envelope. The progressive render
      // (streamed via writer.custom) is keyed to THIS generate_a2ui call — the
      // bridge flushes the outer call onto the wire before the inner render
      // deltas — so the runtime paints the streamed surface and this final
      // envelope under the SAME activity id: the envelope replaces (not
      // duplicates) the streamed surface, and being an a2ui result it is
      // intercepted (no residual generate_a2ui tool card). On exhaustion the
      // envelope carries the a2ui_recovery_exhausted failure instead.
      return parseEnvelope(envelope);
    },
  });
}

/**
 * Parse the toolkit's JSON envelope string into an object so the Mastra bridge
 * single-encodes it onto the wire (see the execute note above). Falls back to
 * the raw string if it is somehow not valid JSON.
 */
function parseEnvelope(envelope: string): unknown {
  try {
    return JSON.parse(envelope);
  } catch {
    return envelope;
  }
}

// ---------------------------------------------------------------------------
// Auto-injection (pillar 1: easy devex) — mirrors @ag-ui/aws-strands
// `planA2UIInjection`. The MastraAgent bridge calls this per run: when the
// runtime/middleware forwarded `injectA2UITool`, it builds the backend-owned
// `generate_a2ui` tool (recovery included) so the DEVELOPER never hand-wires it.
// Opt out with `injectA2UITool:false`; customize via the `A2UIInjectConfig` props.
// ---------------------------------------------------------------------------

/** Marks a tool this adapter auto-injected, so the bridge can refresh (not
 *  "user-prevails") its own prior-turn tool on a cached/multi-turn thread. */
export const A2UI_AUTOINJECT_MARKER = Symbol.for(
  "@ag-ui/mastra.a2uiAutoInjected",
);

/** Backend override knobs for auto-injection (mirrors the runtime `injectA2UITool`
 *  flag + the customizable `getA2UITools` properties). All optional. */
export interface A2UIInjectConfig<TModel = A2UISubagentModel> {
  /** Force on/off from the backend (nullish-falls-back FROM forwardedProps —
   *  an explicit runtime value wins). A string names the injected render tool. */
  injectA2UITool?: boolean | string;
  /** Model the render subagent runs. Required for auto-inject unless the bridge
   *  can infer one from the wrapped agent. */
  model?: TModel;
  /** Catalog id stamped on created surfaces (else resolved from run context). */
  defaultCatalogId?: string;
  /** Prompt knobs (else the run's component schema becomes the composition guide). */
  guidelines?: A2UIGuidelines;
  /** Inline catalog for semantic validation (structural-only when absent). */
  catalog?: A2UIValidationCatalog;
  /** Recovery loop config (attempt cap, etc.). */
  recovery?: A2UIRecoveryConfig;
  /** Per-attempt observability hook. */
  onA2UIAttempt?: (record: A2UIAttemptRecord) => void;
}

/** The per-run injection decision. */
export interface A2UIInjectionPlan {
  /** The `generate_a2ui` Mastra tool to register for this run. */
  tool: ReturnType<typeof getA2UITools>;
  /** Name the tool is registered under (`generate_a2ui`). */
  toolName: string;
  /** Injected render-tool names to drop so the model calls `generate_a2ui`. */
  dropToolNames: string[];
}

export interface PlanA2UIInjectionInput<TModel = A2UISubagentModel> {
  /** Model inferred from the wrapped agent (null when none is inferable). */
  model: TModel | null | undefined;
  /** The run input — read for `forwardedProps.injectA2UITool` + catalog context. */
  input: RunAgentInput;
  /** Tool names already on the agent (USER-PREVAILS dedup). */
  existingToolNames: string[];
  /** Backend override config. */
  config?: A2UIInjectConfig<TModel>;
  /** Logger for the no-model skip warning. */
  log?: { warn: (msg: string) => void };
}

/**
 * Decide whether to auto-inject `generate_a2ui` for this run. Off unless the
 * runtime forwarded `injectA2UITool` (or `config.injectA2UITool` is set);
 * USER-PREVAILS (skip if the dev already wired `generate_a2ui`); skip + warn when
 * no model is available. Otherwise builds the backend recovery tool, resolving
 * the catalog id + composition guide from run context (backend config wins), and
 * drops the middleware-injected render tool so the model calls `generate_a2ui`.
 */
export function planA2UIInjection<TModel = A2UISubagentModel>(
  args: PlanA2UIInjectionInput<TModel>,
): A2UIInjectionPlan | null {
  const { input, existingToolNames, config } = args;
  const log = args.log ?? console;

  // Explicit backend opt-out wins even over a forwarded `true`: an agent that
  // OWNS a fixed-schema A2UI tool sets `a2ui.injectA2UITool:false` so the bridge
  // never auto-injects `generate_a2ui` alongside its own direct tool, even when
  // the runtime blanket-forwards the flag to every A2UI agent.
  if (config?.injectA2UITool === false) return null;

  const forwarded = input.forwardedProps as
    | { injectA2UITool?: boolean | string }
    | undefined;
  const flag = forwarded?.injectA2UITool ?? config?.injectA2UITool;
  if (!flag) return null;

  const toolName = GENERATE_A2UI_TOOL_NAME;
  // USER PREVAILS: never double-inject over a dev-wired generate_a2ui.
  if (existingToolNames.includes(toolName)) return null;

  const model = config?.model ?? args.model;
  if (model == null) {
    log.warn(
      "[@ag-ui/mastra] A2UI tool injection requested but no model could be " +
        "inferred from the agent. Skipping auto-injection — pass `a2ui.model` " +
        "or wire getA2UITools() explicitly.",
    );
    return null;
  }

  const renderToolName =
    typeof flag === "string" ? flag : RENDER_A2UI_TOOL_DEF.function.name;

  // Resolve the frontend catalog id + composition guide from run context so the
  // auto-injected tool grounds surfaces on the host's catalog with no hardcoding.
  // Backend config wins.
  const [schemaValue, regularContext] = splitA2UISchemaContext(
    input.context as Array<Record<string, unknown>> | undefined,
  );
  const state: Record<string, unknown> = {
    "ag-ui": { a2ui_schema: schemaValue, context: regularContext },
  };
  const resolved = resolveA2UICatalog(state);
  const [runtimeSchema, runtimeCatalogId] = resolved ?? [undefined, undefined];

  const defaultCatalogId = config?.defaultCatalogId ?? runtimeCatalogId;
  let guidelines = config?.guidelines;
  if (guidelines === undefined && runtimeSchema !== undefined) {
    guidelines = { compositionGuide: runtimeSchema };
  }

  const tool = getA2UITools({
    model: model as A2UISubagentModel,
    toolName,
    catalog: config?.catalog,
    defaultCatalogId,
    guidelines,
    recovery: config?.recovery,
    onA2UIAttempt: config?.onA2UIAttempt,
  });
  (tool as { [A2UI_AUTOINJECT_MARKER]?: true })[A2UI_AUTOINJECT_MARKER] = true;

  return { tool, toolName, dropToolNames: [renderToolName] };
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
