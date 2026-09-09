import type { AgentCapabilities, SubAgentInfo } from "@ag-ui/core";
import { isAgentTool, isWorkflow, type Runner } from "@google/adk";

import { AGUIClientToolset } from "./client-toolset";
import type { ADKJSResolvedConfig } from "./config";
import { isRecord } from "./value-utils";

/** Static shape of an ADK agent tree, read once per run. */
export interface AgentTreeIndex {
  rootName?: string;
  names: ReadonlySet<string>;
  /** Parent agent name per agent name; the root maps to `undefined`. */
  parent: ReadonlyMap<string, string | undefined>;
  description: ReadonlyMap<string, string>;
  /** Names of agents wrapped by an `AgentTool` (they run out of stream). */
  agentToolNames: ReadonlySet<string>;
}

/** ADK uses an empty string for an absent description. */
function describedAs(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Walk `subAgents`, `AgentTool`-wrapped agents, and workflow graph nodes
 * (including `ParallelWorker` inners and nested workflows), depth first.
 */
function visitAgentTree(
  root: unknown,
  visit: (
    agent: Record<string, unknown>,
    parentName: string | undefined,
  ) => void,
): void {
  const visited = new Set<object>();
  const walk = (node: unknown, parentName: string | undefined): void => {
    if (!isRecord(node) || visited.has(node)) {
      return;
    }
    visited.add(node);
    visit(node, parentName);
    const name = typeof node.name === "string" ? node.name : parentName;
    if (Array.isArray(node.subAgents)) {
      for (const child of node.subAgents) {
        walk(child, name);
      }
    }
    if (Array.isArray(node.tools)) {
      for (const tool of node.tools) {
        if (isAgentTool(tool)) {
          walk((tool as unknown as { agent?: unknown }).agent, name);
        }
      }
    }
    if (isWorkflow(node)) {
      for (const child of node.graph?.nodes ?? []) {
        walk(child, name);
      }
    }
    // ParallelWorker keeps its inner node private; read it structurally.
    walk((node as { inner?: unknown }).inner, name);
  };
  walk(root, undefined);
}

export function indexAgentTree(root: unknown): AgentTreeIndex {
  const names = new Set<string>();
  const parent = new Map<string, string | undefined>();
  const description = new Map<string, string>();
  const agentToolNames = new Set<string>();
  visitAgentTree(root, (agent, parentName) => {
    if (
      typeof agent.name !== "string" ||
      agent.name.length === 0 ||
      agent.name === "__START__" // the workflow graph's entry sentinel
    ) {
      return;
    }
    names.add(agent.name);
    if (!parent.has(agent.name)) {
      parent.set(agent.name, parentName);
    }
    const described = describedAs(agent.description);
    if (described) {
      description.set(agent.name, described);
    }
    if (Array.isArray(agent.tools)) {
      for (const tool of agent.tools) {
        if (isAgentTool(tool) && typeof tool.name === "string") {
          agentToolNames.add(tool.name);
        }
      }
    }
  });
  return {
    ...(isRecord(root) && typeof root.name === "string"
      ? { rootName: root.name }
      : {}),
    names,
    parent,
    description,
    agentToolNames,
  };
}

export function discoverClientToolsets(
  runner: Pick<Runner, "agent">,
): AGUIClientToolset[] {
  const found = new Set<AGUIClientToolset>();
  visitAgentTree(runner.agent, (agent) => {
    if (!Array.isArray(agent.tools)) {
      return;
    }
    for (const tool of agent.tools) {
      if (tool instanceof AGUIClientToolset) {
        found.add(tool);
      }
    }
  });
  return [...found];
}

function directSubAgents(root: unknown): SubAgentInfo[] | undefined {
  if (!isRecord(root)) {
    return undefined;
  }
  const children = isWorkflow(root)
    ? root.graph?.nodes.filter((node) => node.name !== "__START__")
    : root.subAgents;
  if (!Array.isArray(children)) {
    return undefined;
  }
  return children.flatMap((agent): SubAgentInfo[] => {
    if (!isRecord(agent) || typeof agent.name !== "string") {
      return [];
    }
    const description = describedAs(agent.description);
    return [{ name: agent.name, ...(description ? { description } : {}) }];
  });
}

export function capabilitiesFor(
  runtime: ADKJSResolvedConfig,
): AgentCapabilities {
  const { root } = runtime;
  const tree = indexAgentTree(root);
  const subAgents = directSubAgents(root);
  // Frontend tools are attached to the root LlmAgent on demand, so any root
  // with a tools list can receive them; a Workflow root only if a toolset was
  // placed explicitly.
  const clientProvided = runtime.clientToolsets
    ? runtime.clientToolsets.length > 0
    : (isRecord(root) && Array.isArray(root.tools)) ||
      discoverClientToolsets({ agent: root }).length > 0;
  const multiAgent =
    subAgents?.length || tree.agentToolNames.size > 0
      ? {
          supported: true,
          ...(subAgents?.length ? { subAgents, handoffs: true } : {}),
          ...(tree.agentToolNames.size > 0 ? { delegation: true } : {}),
        }
      : undefined;
  const description = tree.rootName
    ? tree.description.get(tree.rootName)
    : undefined;
  const base: AgentCapabilities = {
    identity: {
      ...(tree.rootName ? { name: tree.rootName } : {}),
      ...(description ? { description } : {}),
      type: "google-adk-js",
    },
    transport: { streaming: true },
    tools: { supported: true, clientProvided, parallelCalls: false },
    // The client's snapshot is authoritative; the bridge does not restore
    // session state into a client that arrives without it.
    state: { snapshots: true, deltas: true },
    ...(multiAgent ? { multiAgent } : {}),
    humanInTheLoop: {
      supported: true,
      approvals: true,
      interrupts: true,
    },
  };

  if (!runtime.capabilities) {
    return base;
  }
  const merged = {
    ...base,
    ...runtime.capabilities,
  } as Record<string, unknown>;
  for (const key of Object.keys(runtime.capabilities)) {
    const baseValue = (base as Record<string, unknown>)[key];
    const overrideValue = (runtime.capabilities as Record<string, unknown>)[
      key
    ];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      merged[key] = { ...baseValue, ...overrideValue };
    }
  }
  return merged as AgentCapabilities;
}
