/**
 * Provision the environment and one managed agent per Dojo feature.
 *
 * Idempotent: finds resources by name and only creates what is missing.
 * Writes the resulting IDs to examples/.managed-agents.json for the server.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-xxx pnpm setup:examples
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ENVIRONMENT_NAME, FEATURE_AGENTS, MODEL } from "./agents";
import { isEntry } from "./entry";

export const IDS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), ".managed-agents.json");

export interface ProvisionedIds {
  environmentId: string;
  agents: Record<string, string>;
}

async function ensureEnvironment(client: Anthropic): Promise<string> {
  for await (const environment of client.beta.environments.list()) {
    if (environment.name === ENVIRONMENT_NAME) return environment.id;
  }
  const environment = await client.beta.environments.create({
    name: ENVIRONMENT_NAME,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  return environment.id;
}

async function existingAgentsByName(client: Anthropic): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  for await (const agent of client.beta.agents.list()) byName.set(agent.name, agent.id);
  return byName;
}

async function ensureAgent(
  client: Anthropic,
  existing: Map<string, string>,
  name: string,
  system: string,
): Promise<string> {
  // Reuse by name. Existing agents are not modified: to apply prompt or model
  // changes from agents.ts, archive the agent and re-run setup.
  const found = existing.get(name);
  if (found) return found;
  const agent = await client.beta.agents.create({
    name,
    model: MODEL,
    system,
    // The Dojo features drive tools from the frontend or the server, so the
    // agent's built-in toolset (bash, file editing, web) stays off.
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false } }],
  });
  return agent.id;
}

async function main() {
  const client = new Anthropic();
  const environmentId = await ensureEnvironment(client);
  const existing = await existingAgentsByName(client);
  const agents: Record<string, string> = {};
  for (const spec of FEATURE_AGENTS) {
    agents[spec.feature] = await ensureAgent(client, existing, spec.agentName, spec.system);
    console.log(`  ${spec.feature}: ${agents[spec.feature]}`);
  }
  const ids: ProvisionedIds = { environmentId, agents };
  writeFileSync(IDS_PATH, `${JSON.stringify(ids, null, 2)}\n`);
  console.log(`Environment: ${environmentId}`);
  console.log(`Wrote ${IDS_PATH}`);
}

/**
 * Only provision when this file is the process entry point. `server.ts` imports
 * `IDS_PATH` from here; without the guard that import would create an
 * environment and agents as a side effect — and exit the server process on the
 * first API failure.
 */
const isEntryPoint = (): boolean => isEntry(import.meta.url);

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
