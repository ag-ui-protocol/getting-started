import { configureIntegration } from "./types/integration";
import { StarterAgent } from "@ag-ui/starter";
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from '@ai-sdk/openai';

export const integrations = [
  configureIntegration({
    id: "starter",
    name: "Starter",
    features: ["agentic_chat"],
    agents: async () => {
      return {
        agentic_chat: new StarterAgent(),
      };
    },
  }),
  configureIntegration({
    id: "vercel-ai-sdk",
    name: "Vercel AI SDK",
    features: ["agentic_chat"],
    agents: async () => {
      return {
        agentic_chat: new VercelAISDKAgent({ model: openai('gpt-4o') }),
      };
    },
  }),
];
