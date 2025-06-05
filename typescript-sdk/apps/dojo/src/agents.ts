import { AgentIntegrationConfig } from "./types/integration";
import { MiddlewareStarterAgent } from "@ag-ui/middleware-starter";
import { ServerStarterAgent } from "@ag-ui/server-starter";
import { ServerStarterAllFeaturesAgent } from "@ag-ui/server-starter-all-features";
import { MastraClient } from "@mastra/client-js";
import { MastraAgent } from "@ag-ui/mastra";
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "@ai-sdk/openai";
import { LangGraphAgent } from "@ag-ui/langgraph";
import { AgnoAgent } from "@ag-ui/agno";

export const agentsIntegrations: AgentIntegrationConfig[] = [
  {
    id: "middleware-starter",
    agents: async () => {
      return {
        agentic_chat: new MiddlewareStarterAgent(),
      };
    },
  },
  {
    id: "server-starter",
    agents: async () => {
      return {
        agentic_chat: new ServerStarterAgent({ url: "http://localhost:8000/" }),
      };
    },
  },
  {
    id: "server-starter-all-features",
    agents: async () => {
      return {
        agentic_chat: new ServerStarterAllFeaturesAgent({
          url: "http://localhost:8000/agentic_chat",
        }),
        human_in_the_loop: new ServerStarterAllFeaturesAgent({
          url: "http://localhost:8000/human_in_the_loop",
        }),
        agentic_generative_ui: new ServerStarterAllFeaturesAgent({
          url: "http://localhost:8000/agentic_generative_ui",
        }),
        tool_based_generative_ui: new ServerStarterAllFeaturesAgent({
          url: "http://localhost:8000/tool_based_generative_ui",
        }),
        shared_state: new ServerStarterAllFeaturesAgent({
          url: "http://localhost:8000/shared_state",
        }),
        predictive_state_updates: new ServerStarterAllFeaturesAgent({
          url: "http://localhost:8000/predictive_state_updates",
        }),
      };
    },
  },
  {
    id: "mastra",
    agents: async () => {
      const mastraClient = new MastraClient({
        baseUrl: "http://localhost:4111",
      });

      return MastraAgent.getRemoteAgents({
        mastraClient,
      });
    },
  },
  {
    id: "vercel-ai-sdk",
    agents: async () => {
      return {
        agentic_chat: new VercelAISDKAgent({ model: openai("gpt-4o") }),
      };
    },
  },
  {
    id: "langgraph",
    agents: async () => {
      return {
        agentic_chat: new LangGraphAgent({
          deploymentUrl: "http://localhost:2024",
          graphId: "agentic_chat",
        }),
        agentic_generative_ui: new LangGraphAgent({
          deploymentUrl: "http://localhost:2024",
          graphId: "agentic_generative_ui",
        }),
        human_in_the_loop: new LangGraphAgent({
          deploymentUrl: "http://localhost:2024",
          graphId: "human_in_the_loop",
        }),
        predictive_state_updates: new LangGraphAgent({
          deploymentUrl: "http://localhost:2024",
          graphId: "predictive_state_updates",
        }),
        shared_state: new LangGraphAgent({
          deploymentUrl: "http://localhost:2024",
          graphId: "shared_state",
        }),
        tool_based_generative_ui: new LangGraphAgent({
          deploymentUrl: "http://localhost:2024",
          graphId: "tool_based_generative_ui",
        }),
      };
    },
  },
  {
    id: "agno",
    agents: async () => {
      return {
        agentic_chat: new AgnoAgent({
          url: "http://localhost:8000/agui",
        }),
      };
    },
  },
];
