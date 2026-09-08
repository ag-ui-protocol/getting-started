/**
 * A2UI subagent tool factory for LangGraph TS agents.
 *
 * Thin adapter over ``@ag-ui/a2ui-toolkit`` — the heavy lifting (op builders,
 * prompt assembly, history walkers, output envelope) lives in the toolkit so
 * each new framework adapter (ADK, Mastra, Strands, …) only owns the
 * framework-specific glue: tool decorator, runtime state access, model
 * binding + invoke.
 *
 * Streaming: the subagent's `render_a2ui` call must STREAM to the AG-UI wire so
 * the a2ui middleware paints the surface progressively (the "building" skeleton
 * keys off the inner tool-call's arg deltas, not the final result). On LangGraph
 * this is FREE: the subagent runs `model.stream` inside the graph, so its nested
 * `render_a2ui` tool-call arg deltas surface natively as `OnChatModelStream`
 * events, which the generic `agent.ts` translator already turns into inner
 * TOOL_CALL_START/ARGS/END. So this adapter emits NO A2UI-specific custom events
 * — it just streams the subagent and hands the accumulated args to the recovery
 * loop. (Frameworks whose SDK does NOT surface a nested model stream as wire
 * events — e.g. Strands — own that explicit push in their own adapter.)
 *
 * Example usage in a chat node:
 *
 *   import { getA2UITools } from "@ag-ui/langgraph";
 *
 *   const a2ui = getA2UITools({ model: new ChatOpenAI({ model: "gpt-4o" }) });
 *
 *   const modelWithTools = chatModel.bindTools(
 *     [...state.tools, a2ui],
 *     { parallel_tool_calls: false },
 *   );
 *
 * Signature note: the factory takes a single `A2UIToolParams` object owned by
 * `@ag-ui/a2ui-toolkit`. Every framework adapter (LG, Strands, ADK, …) shares
 * that exact params shape — only the body below is framework-specific. A new
 * knob added to `A2UIToolParams` reaches this adapter with no signature change.
 */

import { tool, type ToolRuntime } from "@langchain/core/tools";
import { SystemMessage } from "@langchain/core/messages";
import {
  A2UI_OPERATIONS_KEY,
  BASIC_CATALOG_ID,
  GENERATE_A2UI_ARG_DESCRIPTIONS,
  RENDER_A2UI_TOOL_DEF,
  buildA2UIEnvelope,
  prepareA2UIRequest,
  resolveA2UIToolParams,
  wrapErrorEnvelope,
  runA2UIGenerationWithRecovery,
  type A2UIToolParams,
} from "@ag-ui/a2ui-toolkit";

/** Name of the render tool the A2UI middleware injects (and the subagent binds). */
const RENDER_A2UI_TOOL_NAME = RENDER_A2UI_TOOL_DEF.function.name;

/**
 * Loose type for the subagent model.
 *
 * Typed as `any` (rather than `BaseChatModel`) to tolerate `@langchain/core` version
 * skew between this package and the consumer — e.g. `ChatOpenAI` shipping its own
 * peer-pinned core. The factory only needs `bindTools` + `stream`, which is checked
 * at runtime.
 */
export type A2UISubagentModel = any;

// Re-export the toolkit constants/types for callers that previously imported
// them from this package — keeps the public surface stable.
export { A2UI_OPERATIONS_KEY, BASIC_CATALOG_ID };
export type { A2UIToolParams };

/** Tool arguments exposed to the main agent's planner. */
interface GenerateA2UIArgs {
  /**
   * `"create"` to render a new surface, `"update"` to modify a surface
   * previously rendered in this conversation. Defaults to `"create"`.
   */
  intent?: "create" | "update";
  /**
   * Required when `intent="update"`. The surface id of the prior render
   * to modify.
   */
  target_surface_id?: string;
  /** Optional natural-language description of the changes to apply on update. */
  changes?: string;
}

/**
 * Run the structured-output subagent once and return the captured `render_a2ui`
 * args — or `null` if the model produced no call.
 *
 * Uses `stream` (not `invoke`) so the nested `render_a2ui` tool-call arg deltas
 * surface natively as the graph's `OnChatModelStream` events — which the generic
 * `agent.ts` translator already turns into inner TOOL_CALL_START/ARGS/END,
 * painting the surface progressively. This adapter emits NO A2UI-specific
 * events: it merely consumes the stream to accumulate the final structured args
 * for the recovery loop.
 */
export async function streamRenderSubagent(
  modelWithTool: A2UISubagentModel,
  prompt: string,
  messages: unknown[],
): Promise<Record<string, unknown> | null> {
  let accumulated: any = null;
  const gen = await modelWithTool.stream([
    new SystemMessage(prompt),
    ...(messages as any[]),
  ]);
  for await (const chunk of gen) {
    // Accumulate the streamed AIMessageChunks so the final parsed tool_calls
    // reconstruct even when each frame carries only an incremental arg fragment.
    // (Surfacing the deltas on the wire is langgraph's job, via the
    // OnChatModelStream events this stream emits.)
    accumulated = accumulated === null ? chunk : accumulated.concat(chunk);
  }

  const toolCalls: Array<{ name?: string; args?: Record<string, unknown> }> =
    accumulated?.tool_calls ?? [];
  for (const call of toolCalls) {
    if (call.name == null || call.name === RENDER_A2UI_TOOL_NAME) {
      return (call.args ?? {}) as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Build a LangGraph tool that delegates A2UI surface generation to a subagent.
 *
 * The returned tool is ready to bind into a chat model alongside any other tools.
 *
 * @param params Shared `A2UIToolParams` (model + behavior knobs). The toolkit
 *   owns the shape and fills defaults via `resolveA2UIToolParams`.
 */
export function getA2UITools<TModel = A2UISubagentModel>(
  params: A2UIToolParams<TModel>,
) {
  // Shared: normalize knobs + fill canonical defaults (toolName, catalogId, …)
  // so this adapter never re-implements default logic. A new params field +
  // its default lives entirely in the toolkit.
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
  // Loose-typed locally: the generic TModel only guarantees the shape the
  // toolkit needs; bindTools/stream are checked at runtime (see guard below).
  const chatModel = model as A2UISubagentModel;

  return tool(
    async (
      input: GenerateA2UIArgs,
      runtime: ToolRuntime<Record<string, unknown>, unknown>,
    ): Promise<string> => {
      // Defensive: a custom state schema (or a non-graph invocation) may not
      // preseed `state`/`messages` — mirror the Python adapter's graceful
      // degrade (`state.get("messages", [])`) instead of throwing mid-tool.
      const state = (runtime.state ?? {}) as Record<string, unknown>;
      const allMessages = (state.messages as Array<any>) ?? [];
      // Strip current (unbalanced) tool call from history.
      const messages = allMessages.slice(0, -1);

      // Shared: decide create/update, find prior surface, build the prompt.
      const prep = prepareA2UIRequest({
        intent: input.intent,
        targetSurfaceId: input.target_surface_id,
        changes: input.changes,
        messages,
        state,
        guidelines,
      });
      if (prep.error) return wrapErrorEnvelope(prep.error);

      // Glue: bind the structured-output tool.
      if (!chatModel.bindTools) {
        return wrapErrorEnvelope("Provided model does not support bindTools");
      }
      const modelWithTool = chatModel.bindTools([RENDER_A2UI_TOOL_DEF], {
        tool_choice: { type: "function", function: { name: "render_a2ui" } },
      });

      // Shared: validate→retry loop. On each retry the prompt is re-augmented
      // with the prior attempt's structured errors; only a validated surface is
      // committed (the middleware gate suppresses any unvalidated attempt, so a
      // rejected attempt never paints). Returns a structured hard-failure
      // envelope once the attempt cap is hit.
      const { envelope } = await runA2UIGenerationWithRecovery({
        basePrompt: prep.prompt,
        catalog,
        config: recovery,
        onAttempt: onA2UIAttempt,
        invokeSubagent: (prompt) =>
          streamRenderSubagent(modelWithTool, prompt, messages),
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
      return envelope;
    },
    {
      name: toolName,
      description: toolDescription,
      schema: {
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
      } as any,
    },
  );
}
