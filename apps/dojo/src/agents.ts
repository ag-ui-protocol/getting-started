import "server-only";

import type { AbstractAgent } from "@ag-ui/client";
import type { AgentsMap } from "./types/agents";
import { mapAgents } from "./utils/agents";
import { MiddlewareStarterAgent } from "@ag-ui/middleware-starter";
import { ServerStarterAgent } from "@ag-ui/server-starter";
import { ServerStarterAllFeaturesAgent } from "@ag-ui/server-starter-all-features";
import { MastraClient } from "@mastra/client-js";
import { MastraAgent } from "@ag-ui/mastra";
// import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
// import { openai } from "@ai-sdk/openai";
import { LangGraphAgent, LangGraphHttpAgent } from "@ag-ui/langgraph";
import { AgnoAgent } from "@ag-ui/agno";
import { LlamaIndexAgent } from "@ag-ui/llamaindex";
import { CrewAIAgent } from "@ag-ui/crewai";
import getEnvVars from "./env";
import { mastra } from "./mastra";
import {
  a2uiDynamicSchemaAgent,
  a2uiRecoveryAgent,
  a2uiInjectConfig,
} from "./mastra/agents/a2ui";
import { a2uiFixedSchemaAgent } from "./mastra/agents/a2ui-fixed";
import { PydanticAIAgent } from "@ag-ui/pydantic-ai";
import { ADKAgent } from "@ag-ui/adk";
import { SpringAiAgent } from "@ag-ui/spring-ai";
import { HttpAgent } from "@ag-ui/client";
import { A2AMiddlewareAgent } from "@ag-ui/a2a-middleware";
import { AWSStrandsAgent } from "@ag-ui/aws-strands";
import { A2AAgent } from "@ag-ui/a2a";
import { A2AClient } from "@a2a-js/sdk/client";
// TODO: fix this — re-enable when langchain dojo agent is restored (see below)
// import { LangChainAgent } from "@ag-ui/langchain";
import { Ag2Agent } from "@ag-ui/ag2";
import { LangroidHttpAgent } from "@ag-ui/langroid";
import { WatsonxAgent } from "@ag-ui/watsonx";
import { A2UIMiddleware } from "@ag-ui/a2ui-middleware";

const envVars = getEnvVars();

// Catalog the dojo's dynamic A2UI demos render against (HotelCard / ProductCard
// / TeamMemberCard / Row).
const A2UI_DOJO_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

// Per-agent A2UI inject whitelist for the adk-middleware integration. These
// subagent demos wire no a2ui tool themselves and rely on the adapter
// auto-injecting `generate_a2ui` when it sees `injectA2UITool`. Injection is
// applied per-agent (NOT integration-wide) so `a2ui_fixed_schema` — which uses
// direct tools — never gets `generate_a2ui` injected. These agents are excluded
// from the runtime-level a2ui config in route.ts to avoid double-applying the
// middleware (the per-request clone copies construction-time `.use()`).
export const ADK_A2UI_INJECT_AGENTS: string[] = ["a2ui_dynamic_schema"];

// Per-agent A2UI inject whitelist for the AWS Strands integrations (TS + Py).
// These demos are plain Strands agents with no a2ui tool of their own and rely
// on the adapter auto-injecting `generate_a2ui`. `a2ui_fixed_schema` is
// deliberately excluded: it wires its OWN backend tools (search_flights /
// search_hotels) that return a fixed-layout envelope, so it must NOT get
// `generate_a2ui` injected alongside them. Injection is applied per-agent here
// (NOT integration-wide) and these agents are excluded from the runtime-level
// a2ui config in route.ts to avoid double-applying the middleware.
export const STRANDS_A2UI_INJECT_AGENTS: string[] = [
  "a2ui_dynamic_schema",
  "a2ui_recovery",
];

export const agentsIntegrations = {
  "middleware-starter": async () => ({
    agentic_chat: new MiddlewareStarterAgent(),
  }),

  "pydantic-ai": async () =>
    mapAgents(
      (path) =>
        new PydanticAIAgent({ url: `${envVars.pydanticAIUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        // TODO: Re-enable this once production builds no longer break
        // predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        backend_tool_rendering: "backend_tool_rendering",
      },
    ),

  "server-starter": async () => ({
    agentic_chat: new ServerStarterAgent({ url: envVars.serverStarterUrl }),
  }),

  "adk-middleware": async () => {
    const agents = mapAgents(
      (path) => new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/${path}` }),
      {
        agentic_chat: "chat",
        agentic_generative_ui: "adk-agentic-generative-ui",
        tool_based_generative_ui: "adk-tool-based-generative-ui",
        human_in_the_loop: "adk-human-in-loop-agent",
        backend_tool_rendering: "backend_tool_rendering",
        shared_state: "adk-shared-state-agent",
        predictive_state_updates: "adk-predictive-state-agent",
        a2ui_fixed_schema: "adk-a2ui-fixed-schema",
        a2ui_dynamic_schema: "adk-a2ui-dynamic-schema",
        a2ui_recovery: "adk-a2ui-recovery",
      },
    );
    // Whitelist-driven per-agent A2UI injection (see ADK_A2UI_INJECT_AGENTS).
    for (const id of ADK_A2UI_INJECT_AGENTS) {
      (agents as Record<string, AbstractAgent>)[id]?.use(
        new A2UIMiddleware({
          injectA2UITool: true,
          defaultCatalogId: A2UI_DOJO_CATALOG_ID,
        }),
      );
    }
    return agents;
  },

  "server-starter-all-features": async () =>
    mapAgents(
      (path) =>
        new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterAllFeaturesUrl}/${path}`,
        }),
      {
        agentic_chat: "agentic_chat",
        // TODO: Add agent for agentic_chat_reasoning
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        tool_based_generative_ui: "tool_based_generative_ui",
        shared_state: "shared_state",
        predictive_state_updates: "predictive_state_updates",
      },
    ),

  mastra: async () => {
    const mastraClient = new MastraClient({
      baseUrl: envVars.mastraUrl,
    });

    return MastraAgent.getRemoteAgents({
      // Cast needed: pnpm may resolve separate @mastra/client-js installations
      // for dojo vs @ag-ui/mastra, causing nominal type mismatch on private fields
      mastraClient: mastraClient as any,
      resourceId: "mastra-agent-remote",
      // Surface Observational Memory background work as AG-UI activity events
      // for the `observational_memory` demo only (default OFF for all others).
      observationalMemory: ["observational_memory"],
    }) as Promise<
      Record<
        | "agentic_chat"
        | "agentic_chat_reasoning"
        | "agentic_chat_multimodal"
        | "backend_tool_rendering"
        | "human_in_the_loop"
        | "interrupt"
        | "shared_state"
        | "tool_based_generative_ui"
        | "a2ui_dynamic_schema"
        | "a2ui_recovery"
        | "a2ui_fixed_schema"
        | "observational_memory",
        AbstractAgent
      >
    >;
  },

  "mastra-agent-local": async () => {
    const base = MastraAgent.getLocalAgents({
      // Cast needed: pnpm may resolve separate @mastra/core installations
      // for dojo vs @ag-ui/mastra, causing nominal type mismatch on private fields
      mastra: mastra as any,
      resourceId: "mastra-agent-local",
      // Surface Observational Memory background work as AG-UI activity events
      // for the `observational_memory` demo only (default OFF for all others).
      observationalMemory: ["observational_memory"],
    });
    // Override the A2UI agents with wrappers carrying the a2ui auto-inject
    // config. The underlying agents wire NO tool — the bridge auto-injects
    // `generate_a2ui` per run (pillar 1). Config MUST go through the constructor
    // so the runtime's per-request `clone()` preserves it.
    const wrapA2UI = (agent: unknown): AbstractAgent =>
      new MastraAgent({
        agent: agent as any,
        resourceId: "mastra-agent-local",
        a2ui: a2uiInjectConfig,
      }) as unknown as AbstractAgent;
    // Fixed-schema owns its own direct tools — opt OUT of auto-injection so the
    // bridge never adds generate_a2ui alongside search_flights/search_hotels.
    const wrapA2UIFixed = (agent: unknown): AbstractAgent =>
      new MastraAgent({
        agent: agent as any,
        resourceId: "mastra-agent-local",
        a2ui: { injectA2UITool: false },
      }) as unknown as AbstractAgent;
    return {
      ...base,
      a2ui_dynamic_schema: wrapA2UI(a2uiDynamicSchemaAgent),
      a2ui_recovery: wrapA2UI(a2uiRecoveryAgent),
      a2ui_fixed_schema: wrapA2UIFixed(a2uiFixedSchemaAgent),
    } as Record<
      | "agentic_chat"
      | "backend_tool_rendering"
      | "human_in_the_loop"
      | "interrupt"
      | "shared_state"
      | "tool_based_generative_ui"
      | "background_agents"
      | "a2ui_dynamic_schema"
      | "a2ui_recovery"
      | "a2ui_fixed_schema"
      | "observational_memory",
      AbstractAgent
    >;
  },

  // Disabled until we can support Vercel AI SDK v5
  // "vercel-ai-sdk": async () => ({
  //   agentic_chat: new VercelAISDKAgent({ model: openai("gpt-5.5") }),
  // }),

  langgraph: async () => ({
    ...mapAgents(
      (graphId) => {
        return new LangGraphAgent({
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId,
        });
      },
      {
        agentic_chat: "agentic_chat",
        agentic_chat_reasoning: "agentic_chat_reasoning",
        agentic_chat_multimodal: "agentic_chat_multimodal",
        backend_tool_rendering: "backend_tool_rendering",
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        subgraphs: "subgraphs",
      },
    ),
    // A2UI Chat with middleware
    a2ui_chat: (() => {
      const agent = new LangGraphAgent({
        deploymentUrl: envVars.langgraphPythonUrl,
        graphId: "a2ui_chat",
      });
      agent.use(new A2UIMiddleware({ injectA2UITool: true }));
      return agent;
    })(),
    a2ui_dynamic_schema: new LangGraphAgent({
      deploymentUrl: envVars.langgraphPythonUrl,
      graphId: "a2ui_dynamic_schema",
    }),
    a2ui_fixed_schema: new LangGraphAgent({
      deploymentUrl: envVars.langgraphPythonUrl,
      graphId: "a2ui_fixed_schema",
    }),
    // Advanced: same backend agent, frontend adds custom progress renderer + action handlers
    a2ui_advanced: new LangGraphAgent({
      deploymentUrl: envVars.langgraphPythonUrl,
      graphId: "a2ui_dynamic_schema",
    }),
  }),

  "langgraph-fastapi": async () => ({
    ...mapAgents(
      (path) =>
        new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/${path}`,
        }),
      {
        agentic_chat: "agentic_chat",
        agentic_chat_multimodal: "agentic_chat_multimodal",
        agentic_chat_reasoning: "agentic_chat_reasoning",
        backend_tool_rendering: "backend_tool_rendering",
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        subgraphs: "subgraphs",
      },
    ),
    a2ui_fixed_schema: new LangGraphHttpAgent({
      url: `${envVars.langgraphFastApiUrl}/agent/a2ui_fixed_schema`,
    }),
    a2ui_dynamic_schema: new LangGraphHttpAgent({
      url: `${envVars.langgraphFastApiUrl}/agent/a2ui_dynamic_schema`,
    }),
    // Advanced: same backend agent, frontend adds custom progress renderer + action handlers
    a2ui_advanced: new LangGraphHttpAgent({
      url: `${envVars.langgraphFastApiUrl}/agent/a2ui_dynamic_schema`,
    }),
  }),

  "langgraph-typescript": async () => ({
    ...mapAgents(
      (graphId) => {
        return new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId,
        });
      },
      {
        agentic_chat: "agentic_chat",
        agentic_chat_multimodal: "agentic_chat_multimodal",
        agentic_chat_reasoning: "agentic_chat_reasoning",
        // TODO: Add agent for backend_tool_rendering
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        subgraphs: "subgraphs",
      },
    ),
    a2ui_dynamic_schema: new LangGraphAgent({
      deploymentUrl: envVars.langgraphTypescriptUrl,
      graphId: "a2ui_dynamic_schema",
    }),
    a2ui_fixed_schema: new LangGraphAgent({
      deploymentUrl: envVars.langgraphTypescriptUrl,
      graphId: "a2ui_fixed_schema",
    }),
    // Advanced: same backend agent, frontend adds custom progress renderer + action handlers
    a2ui_advanced: new LangGraphAgent({
      deploymentUrl: envVars.langgraphTypescriptUrl,
      graphId: "a2ui_dynamic_schema",
    }),
    // OSS-162: A2UI error-recovery showcase (sub-agent emits a structural error,
    // then recovers). Rides the runtime a2ui middleware like the others.
    a2ui_recovery: new LangGraphAgent({
      deploymentUrl: envVars.langgraphTypescriptUrl,
      graphId: "a2ui_recovery",
    }),
  }),

  // TODO: fix this — CopilotKit 1.60.x bump flips @langchain/openai onto
  // @langchain/core@1.1.40, which clashes with @ag-ui/langchain (pinned to
  // core@0.3.80) and breaks the chainFn type-check. Re-enable once resolved.
  // TODO: @ranst91 Enable `langchain` integration in apps/dojo/src/menu.ts once ready
  // langchain: async () => {
  //   const agent = new LangChainAgent({
  //     chainFn: async ({ messages, tools, threadId }) => {
  //       const { ChatOpenAI } = await import("@langchain/openai");
  //       const chatOpenAI = new ChatOpenAI({ model: "gpt-5.5" });
  //       const model = chatOpenAI.bindTools(tools, {
  //         strict: true,
  //       });
  //       return model.stream(messages, {
  //         tools,
  //         metadata: { conversation_id: threadId },
  //       });
  //     },
  //   });
  //   return {
  //     agentic_chat: agent,
  //     tool_based_generative_ui: agent,
  //   };
  // },

  agno: async () =>
    mapAgents(
      (path) => new AgnoAgent({ url: `${envVars.agnoUrl}/${path}/agui` }),
      {
        agentic_chat: "agentic_chat",
        agentic_chat_reasoning: "agentic_chat_reasoning",
        agentic_chat_multimodal: "agentic_chat_multimodal",
        agentic_generative_ui: "agentic_generative_ui",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
      },
    ),

  "spring-ai": async () =>
    mapAgents(
      (path) =>
        new SpringAiAgent({ url: `${envVars.springAiUrl}/${path}/agui` }),
      {
        agentic_chat: "agentic_chat",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
      },
    ),

  "llama-index": async () =>
    mapAgents(
      (path) =>
        new LlamaIndexAgent({ url: `${envVars.llamaIndexUrl}/${path}/run` }),
      {
        agentic_chat: "agentic_chat",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        backend_tool_rendering: "backend_tool_rendering",
      },
    ),

  crewai: async () =>
    mapAgents(
      (path) => new CrewAIAgent({ url: `${envVars.crewAiUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        // TODO: Add agent for backend_tool_rendering
        // backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        tool_based_generative_ui: "tool_based_generative_ui",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        predictive_state_updates: "predictive_state_updates",
        crew_chat: "crew_chat",
        error_flow: "error_flow",
      },
    ),

  "agent-spec-langgraph": async () =>
    mapAgents(
      (path) =>
        new HttpAgent({
          url: `${envVars.agentSpecUrl}/langgraph/${path}`,
        }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        tool_based_generative_ui: "tool_based_generative_ui",
      },
    ),

  "agent-spec-wayflow": async () =>
    mapAgents(
      (path) =>
        new HttpAgent({
          url: `${envVars.agentSpecUrl}/wayflow/${path}`,
        }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        tool_based_generative_ui: "tool_based_generative_ui",
        human_in_the_loop: "human_in_the_loop",
      },
    ),

  "microsoft-agent-framework-python": async () =>
    mapAgents(
      (path) =>
        new HttpAgent({ url: `${envVars.agentFrameworkPythonUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        predictive_state_updates: "predictive_state_updates",
      },
    ),

  "a2a-basic": async () => {
    const a2aClient = new A2AClient(envVars.a2aUrl);
    return {
      vnext_chat: new A2AAgent({
        description: "Direct A2A agent",
        a2aClient,
        debug: process.env.NODE_ENV !== "production",
      }),
    };
  },

  "microsoft-agent-framework-dotnet": async () =>
    mapAgents(
      (path) =>
        new HttpAgent({ url: `${envVars.agentFrameworkDotnetUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        predictive_state_updates: "predictive_state_updates",
        subgraphs: "subgraphs",
      },
    ),

  "ag-ui-dotnet": async () =>
    mapAgents(
      (path) => new HttpAgent({ url: `${envVars.aguiDotnetUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        v1_agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        predictive_state_updates: "predictive_state_updates",
      },
    ),

  a2a: async () => {
    // A2A agents: building management, finance, it agents
    const agentUrls = [
      envVars.a2aMiddlewareBuildingsManagementUrl,
      envVars.a2aMiddlewareFinanceUrl,
      envVars.a2aMiddlewareItUrl,
    ];
    // AGUI orchestration/routing agent
    const orchestrationAgent = new HttpAgent({
      url: envVars.a2aMiddlewareOrchestratorUrl,
    });
    return {
      a2a_chat: new A2AMiddlewareAgent({
        description: "Middleware that connects to remote A2A agents",
        agentUrls,
        orchestrationAgent,
        instructions: `
          You are an HR agent. You are responsible for hiring employees and other typical HR tasks.

          It's very important to contact all the departments necessary to complete the task.
          For example, to hire an employee, you must contact all 3 departments: Finance, IT and Buildings Management. Help the Buildings Management department to find a table.

          You can make tool calls on behalf of other agents.
          DO NOT FORGET TO COMMUNICATE BACK TO THE RELEVANT AGENT IF MAKING A TOOL CALL ON BEHALF OF ANOTHER AGENT!!!

          When choosing a seat with the buildings management agent, You MUST use the \`pickTable\` tool to have the user pick a seat.
          The buildings management agent will then use the \`pickSeat\` tool to pick a seat.
          `,
      }),
    };
  },

  "aws-strands": async () => {
    const agents = {
      ...mapAgents(
        (path) =>
          new AWSStrandsAgent({ url: `${envVars.awsStrandsUrl}/${path}/` }),
        {
          agentic_chat: "agentic-chat",
          agentic_chat_reasoning: "agentic-chat-reasoning",
          agentic_chat_multimodal: "agentic-chat-multimodal",
          // v1 page reuses the agentic-chat endpoint (menu advertises the
          // feature; this mapping was missing).
          v1_agentic_chat: "agentic-chat",
          backend_tool_rendering: "backend-tool-rendering",
          agentic_generative_ui: "agentic-generative-ui",
          shared_state: "shared-state",
          // A2UI dynamic/recovery: plain Strands agents with no a2ui wiring;
          // they get per-agent `generate_a2ui` injection below. fixed_schema
          // wires its own backend tools, so it is NOT in the inject whitelist.
          a2ui_dynamic_schema: "a2ui-dynamic-schema",
          a2ui_fixed_schema: "a2ui-fixed-schema",
          a2ui_recovery: "a2ui-recovery",
        },
      ),
      human_in_the_loop: new AWSStrandsAgent({
        url: `${envVars.awsStrandsUrl}/human-in-the-loop`,
        debug: true,
      }),
    };
    for (const id of STRANDS_A2UI_INJECT_AGENTS) {
      (agents as Record<string, AbstractAgent>)[id]?.use(
        new A2UIMiddleware({
          injectA2UITool: true,
          defaultCatalogId: A2UI_DOJO_CATALOG_ID,
        }),
      );
    }
    return agents;
  },

  "aws-strands-typescript": async () => {
    // TS example server mounts every endpoint on hyphenated paths (matching the
    // Python reference server) so the same curl payloads drive both adapters.
    // v1_agentic_chat reuses the agentic-chat endpoint — the dojo page renders
    // the same agent via the v1 CopilotChat UI instead of the v2 shell.
    const agents = {
      ...mapAgents(
        (path) =>
          new AWSStrandsAgent({
            url: `${envVars.awsStrandsTypescriptUrl}/${path}/`,
          }),
        {
          agentic_chat: "agentic-chat",
          agentic_chat_reasoning: "agentic-chat-reasoning",
          agentic_chat_multimodal: "agentic-chat-multimodal",
          v1_agentic_chat: "agentic-chat",
          backend_tool_rendering: "backend-tool-rendering",
          agentic_generative_ui: "agentic-generative-ui",
          shared_state: "shared-state",
          tool_based_generative_ui: "tool-based-generative-ui",
          // A2UI dynamic/recovery are auto-injected per-agent below;
          // fixed_schema wires its own backend tools (no injection).
          a2ui_dynamic_schema: "a2ui-dynamic-schema",
          a2ui_fixed_schema: "a2ui-fixed-schema",
          a2ui_recovery: "a2ui-recovery",
        },
      ),
      human_in_the_loop: new AWSStrandsAgent({
        url: `${envVars.awsStrandsTypescriptUrl}/human-in-the-loop`,
        debug: true,
      }),
    };
    for (const id of STRANDS_A2UI_INJECT_AGENTS) {
      (agents as Record<string, AbstractAgent>)[id]?.use(
        new A2UIMiddleware({
          injectA2UITool: true,
          defaultCatalogId: A2UI_DOJO_CATALOG_ID,
        }),
      );
    }
    return agents;
  },

  ag2: async () =>
    mapAgents((path) => new Ag2Agent({ url: `${envVars.ag2Url}/${path}` }), {
      agentic_chat: "agentic_chat",
      backend_tool_rendering: "backend_tool_rendering",
      human_in_the_loop: "human_in_the_loop",
      agentic_generative_ui: "agentic_generative_ui",
      shared_state: "shared_state",
      tool_based_generative_ui: "tool_based_generative_ui",
    }),

  "openai-agents-python": async () =>
    mapAgents(
      (path) =>
        new HttpAgent({ url: `${envVars.openaiAgentsPythonUrl}/${path}/` }),
      {
        ag_ui_docs_copilot: "ag_ui_docs_copilot",
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        human_in_the_loop_approval: "human_in_the_loop_approval",
        tool_based_generative_ui: "tool_based_generative_ui",
        subagents: "subagents",
        custom_lifecycle_events: "custom_lifecycle_events",
        dynamic_system_prompt: "dynamic_system_prompt",
      },
    ),

  "claude-agent-sdk-python": async () =>
    mapAgents(
      (path) =>
        new HttpAgent({ url: `${envVars.claudeAgentSdkPythonUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        shared_state: "shared_state",
        human_in_the_loop: "human_in_the_loop",
        tool_based_generative_ui: "tool_based_generative_ui",
      },
    ),

  "claude-agent-sdk-typescript": async () =>
    mapAgents(
      (path) =>
        new HttpAgent({
          url: `${envVars.claudeAgentSdkTypescriptUrl}/${path}`,
        }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        shared_state: "shared_state",
        human_in_the_loop: "human_in_the_loop",
        tool_based_generative_ui: "tool_based_generative_ui",
      },
    ),

  langroid: async () =>
    mapAgents(
      (path) =>
        new LangroidHttpAgent({ url: `${envVars.langroidUrl}/${path}/` }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
      },
    ),

  watsonx: async () => {
    const agent = new WatsonxAgent({
      region: envVars.watsonxRegion,
      instanceId: envVars.watsonxInstanceId,
      agentId: envVars.watsonxAgentId,
      apiKey: envVars.watsonxApiKey,
    });
    return {
      agentic_chat: agent,
    };
  },
} satisfies AgentsMap;
