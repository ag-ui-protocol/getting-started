/** Utilities for forwarding client-defined tools to the Strands agent at runtime. */

import {
  Agent,
  TextBlock,
  ToolResultBlock,
  type Tool,
  type ToolContext,
  type ToolSpec,
  type ToolStreamGenerator,
} from "@strands-agents/sdk";
import type { Tool as AguiTool } from "@ag-ui/core";

import { DEFAULT_LOGGER, type Logger } from "./logger";

const LOG_PREFIX = "[@ag-ui/aws-strands]";

/**
 * Result text a proxy tool returns server-side, standing in for the answer the
 * client is going to produce. Exported so reconciliation can recognise the
 * exact stub it has to overwrite; the string itself is matched verbatim
 * against persisted history, so it must not be reworded.
 */
export const PROXY_RESULT_PLACEHOLDER = "Forwarded to client";

/** Derived from `Agent.toolRegistry` because Strands doesn't re-export the type. */
export type StrandsToolRegistry = Agent["toolRegistry"];

// Symbol set on proxy tools so we can distinguish them from native tools.
const PROXY_MARKER = Symbol.for("@ag-ui/aws-strands.proxyTool");

interface ProxyTool extends Tool {
  readonly [PROXY_MARKER]: true;
}

/**
 * Convert an AG-UI `Tool` into a Strands proxy `Tool`.
 *
 * When invoked server-side the proxy returns a placeholder result — the real
 * execution happens on the client. Proxy tools are distinguishable from
 * tools registered at server startup via an internal symbol marker.
 */
export function createProxyTool(tool: AguiTool): Tool {
  // Strands' tool registry rejects empty-string descriptions, and Bedrock
  // requires a non-empty description on every tool spec. Frontend tools
  // routed through CopilotKit don't always provide one, so synthesise a
  // minimal placeholder from the tool name when missing.
  const description =
    tool.description && tool.description.length > 0
      ? tool.description
      : `Client-side tool: ${tool.name}`;
  const spec: ToolSpec = {
    name: tool.name,
    description,
    inputSchema: (tool.parameters ?? {
      type: "object",
      properties: {},
    }) as ToolSpec["inputSchema"],
  };
  const proxy: ProxyTool = {
    name: spec.name,
    description,
    toolSpec: spec,
    [PROXY_MARKER]: true,
    // `yield` is deliberately omitted — the adapter filters the placeholder
    // result out before it becomes a TOOL_CALL_RESULT on the wire. The
    // generator type keeps the Strands contract happy.
    async *stream(toolContext: ToolContext): ToolStreamGenerator {
      return new ToolResultBlock({
        toolUseId: toolContext.toolUse.toolUseId,
        status: "success",
        content: [new TextBlock(PROXY_RESULT_PLACEHOLDER)],
      });
    },
  };
  return proxy;
}

/** Returns `true` if `tool` was created by `createProxyTool`. */
export function isProxyTool(tool: unknown): boolean {
  return (
    typeof tool === "object" &&
    tool !== null &&
    (tool as { [PROXY_MARKER]?: boolean })[PROXY_MARKER] === true
  );
}

/**
 * Synchronise proxy tools in `toolRegistry` with `aguiTools`.
 *
 * - New tools present in `aguiTools` but absent from the registry are
 *   registered (unless a native, non-proxy tool with the same name exists).
 * - Stale proxy tools in `trackedNames` but absent from `aguiTools` are
 *   removed.
 *
 * Returns the updated set of proxy tool names currently registered.
 */
export function syncProxyTools(
  toolRegistry: StrandsToolRegistry,
  aguiTools: AguiTool[],
  trackedNames: Set<string>,
  log: Logger = DEFAULT_LOGGER,
): Set<string> {
  const desiredNames = new Set<string>();
  for (const t of aguiTools) {
    if (t.name) desiredNames.add(t.name);
  }

  // Remove stale proxy tools.
  for (const name of trackedNames) {
    if (desiredNames.has(name)) continue;
    const existing = toolRegistry.get(name);
    if (existing && isProxyTool(existing)) {
      toolRegistry.remove(name);
      log.debug(`${LOG_PREFIX} Removed stale proxy tool: ${name}`);
    }
  }

  // Add or refresh proxy tools.
  const current = new Set<string>();
  for (const t of aguiTools) {
    if (!t.name) continue;
    const existing = toolRegistry.get(t.name);
    if (existing && !isProxyTool(existing)) {
      // Native tool shadows client tool — warn so integrators can detect
      // the collision (client's tool will never execute).
      log.warn(
        `${LOG_PREFIX} Native tool "${t.name}" shadows client-declared tool with the same name; client tool will not be registered`,
      );
      continue;
    }
    if (existing) {
      // Remove then re-register to pick up any schema changes.
      toolRegistry.remove(t.name);
    }
    toolRegistry.add(createProxyTool(t));
    current.add(t.name);
    log.debug(`${LOG_PREFIX} Registered proxy tool: ${t.name}`);
  }

  return current;
}
