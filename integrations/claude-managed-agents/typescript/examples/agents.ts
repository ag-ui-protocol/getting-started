/**
 * The managed agents behind each Dojo feature. `setup.ts` provisions them;
 * `server.ts` serves them. Add a feature by adding an entry here.
 */

export interface FeatureAgentSpec {
  /** Route name and Dojo feature id. */
  feature: string;
  /** Managed agent name (used to find or create it idempotently). */
  agentName: string;
  system: string;
}

export const MODEL = process.env.MANAGED_AGENTS_MODEL ?? "claude-sonnet-5";
export const ENVIRONMENT_NAME = "ag-ui-dojo";

export const FEATURE_AGENTS: FeatureAgentSpec[] = [
  {
    feature: "agentic_chat",
    agentName: "ag-ui-dojo-agentic-chat",
    system: "You are a helpful assistant. Keep replies concise.",
  },
  {
    feature: "backend_tool_rendering",
    agentName: "ag-ui-dojo-backend-tool-rendering",
    system:
      "You are a helpful assistant. When the user asks about the weather, call the " +
      "get_weather tool and then summarize the result in a sentence.",
  },
  {
    feature: "human_in_the_loop",
    agentName: "ag-ui-dojo-human-in-the-loop",
    system:
      "You are a task planning assistant. For every request, IMMEDIATELY call the " +
      "generate_task_steps tool with about 10 steps, each an object with `description` " +
      "(brief imperative) and `status` set to \"enabled\". Do not repeat the steps as text; " +
      "the UI shows them. After the user approves steps via the tool result, confirm briefly.",
  },
  {
    feature: "tool_based_generative_ui",
    agentName: "ag-ui-dojo-tool-based-generative-ui",
    system:
      "You are a haiku assistant. When asked, call the generate_haiku tool with the " +
      "haiku's lines in Japanese and English. Keep any other text short.",
  },
];
