/**
 * Custom middleware helpers for ag-ui LangGraph agents.
 */

import { createMiddleware } from "langchain";
import { BaseMessage, ToolMessage } from "@langchain/core/messages";

export interface StateItem {
  stateKey: string;
  tool: string;
  toolArgument: string;
}

/** Identity helper — exists purely for IDE type inference on the object literal. */
export const stateItem = (item: StateItem): StateItem => item;

/**
 * Middleware that injects `predict_state` metadata into model invocations so
 * that every `on_chat_model_stream` event carries it.
 *
 * Approach: wrap `request.model` with `model.withConfig({ metadata: {
 * predict_state } })` before passing it to the base handler. When the base
 * handler subsequently calls `bindTools()` on this RunnableBinding,
 * `_simpleBindTools` detects the RunnableBinding wrapper and creates a new
 * RunnableBinding that **preserves our config**. `RunnableBinding.invoke()`
 * then uses `mergeConfigs()` (which deep-merges metadata) to combine our
 * bound config with the LangGraph execution config, so `predict_state`
 * survives into every streaming event.
 */
export const stateStreamingMiddleware = (...items: StateItem[]) => {
  const predictState = items.map((i) => ({
    state_key: i.stateKey,
    tool: i.tool,
    tool_argument: i.toolArgument,
  }));

  const trackedTools = new Set(items.map((i) => i.tool));

  /**
   * Return true if intermediate state should be injected for this model call.
   *
   * Suppress only when the last tool that ran is one we track. If we injected
   * again after a tracked tool, predict_state would stream a second time for
   * that same tool on its next invocation — a true duplicate stream. Untracked
   * tools (e.g. open_canvas) are safe to inject after because the next call
   * may need to stream a tracked tool.
   */
  const isPreToolCall = (request: { messages?: BaseMessage[] }): boolean => {
    const msgs = request?.messages ?? [];
    if (msgs.length === 0) return true;
    const last = msgs[msgs.length - 1];
    if (!(last instanceof ToolMessage)) return true;
    return !trackedTools.has(last.name ?? "");
  };

  return createMiddleware({
    name: "StateStreamingMiddleware",
    wrapModelCall: async (request, handler) => {
      if (!isPreToolCall(request)) {
        return handler(request);
      }
      const modelWithState = (request.model as any).withConfig({
        metadata: { predict_state: predictState },
      });

      const m = request.model as any;
      const proto = Object.getPrototypeOf(m);
      const origCombine = proto._combineCallOptions;
      if (origCombine) {
        proto._combineCallOptions = function (options: any) {
          const combined = origCombine.call(this, options);
          combined.metadata = {
            ...(this.defaultOptions?.metadata ?? {}),
            ...(options?.metadata ?? {}),
            predict_state: predictState,
          };
          return combined;
        };
      }
      try {
        return await handler({ ...request, model: modelWithState });
      } finally {
        if (origCombine) proto._combineCallOptions = origCombine;
      }
    },
  });
};
