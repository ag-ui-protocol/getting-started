import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpointSingleRoute,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import type { AbstractAgent } from "@ag-ui/client";

import {
  agentsIntegrations,
  ADK_A2UI_INJECT_AGENTS,
  STRANDS_A2UI_INJECT_AGENTS,
  CREWAI_A2UI_INJECT_AGENTS,
} from "@/agents";
import { IntegrationId } from "@/menu";
import { getPostHogClient } from "@/lib/posthog-server";

type RouteParams = {
  params: Promise<{
    integrationId: string;
    slug?: string[];
  }>;
};

const handlerCache = new Map<string, ReturnType<typeof handle>>();

async function getHandler(integrationId: string) {
  const cached = handlerCache.get(integrationId);
  if (cached) {
    return cached;
  }

  const getAgents = agentsIntegrations[integrationId as IntegrationId];
  if (!getAgents) {
    return null;
  }

  const agents = await getAgents();

  // The LangGraph a2ui demos rely on the runtime forwarding `injectA2UITool`
  // integration-wide (their tools are defined in-backend but the dojo demos
  // expect injection). The AWS Strands integrations no longer inject here:
  // their dynamic/recovery demos apply per-agent A2UIMiddleware (with
  // injectA2UITool) in agents.ts via STRANDS_A2UI_INJECT_AGENTS, while
  // `a2ui_fixed_schema` wires its OWN backend tools and must NOT get
  // `generate_a2ui` injected alongside them.
  // LangGraph + Mastra + MAF-python rely on the runtime forwarding
  // `injectA2UITool`: their demos wire NO A2UI tool and the adapter/bridge
  // auto-injects `generate_a2ui` when it sees the flag (Mastra via
  // @ag-ui/mastra planA2UIInjection in the bridge; MAF-python via the adapter's
  // plan_a2ui_injection, server-side). Strands/ADK apply their OWN per-agent
  // middleware instead.
  const injectsA2UITool =
    integrationId.includes("langgraph") ||
    integrationId === "mastra-agent-local" ||
    integrationId === "microsoft-agent-framework-python";

  // Agents whose A2UI rendering the runtime auto-applies A2UIMiddleware for.
  // Inject-whitelisted agents (ADK_A2UI_INJECT_AGENTS / STRANDS_A2UI_INJECT_AGENTS)
  // apply their OWN per-agent A2UIMiddleware (with injectA2UITool) in agents.ts,
  // so they're excluded here — otherwise the middleware would be applied twice
  // (the per-request clone preserves the construction-time `.use()`).
  const allA2UIAgents = [
    "a2ui_fixed_schema",
    "a2ui_dynamic_schema",
    "a2ui_advanced",
    "a2ui_recovery",
  ];
  const perAgentInjectIds =
    integrationId === "adk-middleware"
      ? ADK_A2UI_INJECT_AGENTS
      : integrationId === "aws-strands" ||
          integrationId === "aws-strands-typescript"
        ? STRANDS_A2UI_INJECT_AGENTS
        : integrationId === "crewai" ||
            integrationId === "crewai-conversational-flows"
          ? CREWAI_A2UI_INJECT_AGENTS
          : [];
  const a2uiAgents = allA2UIAgents.filter(
    (id) => !perAgentInjectIds.includes(id),
  );

  const runtime = new CopilotRuntime({
    agents: agents as Record<string, AbstractAgent>,
    runner: new InMemoryAgentRunner(),
    a2ui: {
      agents: a2uiAgents,
      // Catalog used when creating a surface from a STREAMED render_a2ui call.
      // Only the dynamic (subagent) agents stream; fixed_schema uses direct
      // tools that carry their own catalog in the result envelope, so a single
      // catalog id here is correct for every streaming agent.
      defaultCatalogId: "https://a2ui.org/demos/dojo/dynamic_catalog.json",
      ...(injectsA2UITool ? { injectA2UITool: true } : {}),
    },
  });

  const app = createCopilotEndpointSingleRoute({
    runtime,
    basePath: `/api/copilotkit/${integrationId}`,
  });

  const handler = handle(app);
  handlerCache.set(integrationId, handler);
  return handler;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = await getHandler(integrationId);
  if (!handler) {
    return new Response("Integration not found", { status: 404 });
  }
  const distinctId =
    request.headers.get("x-posthog-distinct-id") || "anonymous";
  const posthog = getPostHogClient();
  posthog?.capture({
    distinctId,
    event: "agent_api_request",
    properties: {
      integration_id: integrationId,
    },
  });
  return handler(request);
}
