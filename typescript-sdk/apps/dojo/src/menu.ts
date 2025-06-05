import { MenuIntegrationConfig } from "./types/integration";

export const menuIntegrations: MenuIntegrationConfig[] = [
  {
    id: "middleware-starter",
    name: "Middleware Starter",
    features: ["agentic_chat"],
  },
  {
    id: "server-starter",
    name: "Server Starter",
    features: ["agentic_chat"],
  },
  {
    id: "server-starter-all-features",
    name: "Server Starter All Features",
    features: [
      "agentic_chat",
      "human_in_the_loop",
      "agentic_generative_ui",
      "tool_based_generative_ui",
      "shared_state",
      "predictive_state_updates",
    ],
  },
  {
    id: "mastra",
    name: "Mastra",
    features: ["agentic_chat"],
  },
  {
    id: "vercel-ai-sdk",
    name: "Vercel AI SDK",
    features: ["agentic_chat"],
  },
  {
    id: "langgraph",
    name: "LangGraph",
    features: [
      "agentic_chat",
      "human_in_the_loop",
      "agentic_generative_ui",
      "tool_based_generative_ui",
      "predictive_state_updates",
      "shared_state",
    ],
  },
  {
    id: "agno",
    name: "Agno",
    features: ["agentic_chat"],
  },
];
