import type { AgentCapabilities, SubAgentInfo } from "@ag-ui/core";
import type { Runner } from "@google/adk";

import { AGUIClientToolset } from "./client-toolset";
import type { ADKRuntimeConfig } from "./config";
import { isRecord } from "./value-utils";

function visitAgentTree(
  root: unknown,
  visit: (agent: Record<string, unknown>) => void,
): void {
  const visited = new Set<object>();
  const walk = (agent: unknown): void => {
    if (!isRecord(agent) || visited.has(agent)) {
      return;
    }
    visited.add(agent);
    visit(agent);
    if (Array.isArray(agent.subAgents)) {
      for (const child of agent.subAgents) {
        walk(child);
      }
    }
  };
  walk(root);
}

export function discoverClientToolsets(runner: Runner): AGUIClientToolset[] {
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

export function discoverAgentNames(runner: Runner): ReadonlySet<string> {
  const names = new Set<string>();
  visitAgentTree(runner.agent, (agent) => {
    if (typeof agent.name === "string" && agent.name.length > 0) {
      names.add(agent.name);
    }
  });
  return names;
}

function directSubAgents(root: unknown): SubAgentInfo[] | undefined {
  if (!isRecord(root) || !Array.isArray(root.subAgents)) {
    return undefined;
  }
  return root.subAgents.flatMap((agent): SubAgentInfo[] => {
    if (!isRecord(agent) || typeof agent.name !== "string") {
      return [];
    }
    return [
      {
        name: agent.name,
        ...(typeof agent.description === "string"
          ? { description: agent.description }
          : {}),
      },
    ];
  });
}

export function capabilitiesFor(runtime: ADKRuntimeConfig): AgentCapabilities {
  const root = runtime.sharedRunner?.agent as
    | { name?: string; description?: string }
    | undefined;
  const subAgents = directSubAgents(runtime.sharedRunner?.agent);
  const clientProvided = Array.isArray(runtime.clientToolsetsResolver)
    ? runtime.clientToolsetsResolver.length > 0
    : typeof runtime.clientToolsetsResolver === "function"
      ? true
      : runtime.sharedRunner
        ? discoverClientToolsets(runtime.sharedRunner).length > 0
        : undefined;
  const base: AgentCapabilities = {
    identity: {
      name: root?.name,
      description: root?.description,
      type: "google-adk-js",
    },
    transport: { streaming: true },
    tools: {
      supported: true,
      ...(clientProvided !== undefined ? { clientProvided } : {}),
      parallelCalls: false,
    },
    state: {
      snapshots: true,
      deltas: true,
      ...(runtime.sharedRunner ? { persistentState: true } : {}),
    },
    ...(subAgents?.length
      ? { multiAgent: { supported: true, subAgents } }
      : {}),
    humanInTheLoop: {
      supported: true,
      approvals: true,
      interrupts: true,
    },
  };

  if (!runtime.capabilityOverrides) {
    return base;
  }
  const merged = {
    ...base,
    ...runtime.capabilityOverrides,
  } as Record<string, unknown>;
  for (const key of Object.keys(runtime.capabilityOverrides)) {
    const baseValue = (base as Record<string, unknown>)[key];
    const overrideValue = (
      runtime.capabilityOverrides as Record<string, unknown>
    )[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      merged[key] = { ...baseValue, ...overrideValue };
    }
  }
  return merged as AgentCapabilities;
}
