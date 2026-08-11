import { FeatureConfig } from "@/types/feature";

// A helper method to creating a config
function createFeatureConfig({
  id,
  name,
  description,
  tags,
}: Pick<FeatureConfig, "id" | "name" | "description" | "tags">): FeatureConfig {
  return {
    id,
    name,
    description,
    path: `/feature/${id}`,
    tags,
  };
}

export const featureConfig: FeatureConfig[] = [
  createFeatureConfig({
    id: "agentic_chat",
    name: "Agentic Chat",
    description: "Chat with your Copilot and call frontend tools",
    tags: ["Chat", "Tools", "Streaming"],
  }),
  createFeatureConfig({
    id: "backend_tool_rendering",
    name: "Backend Tool Rendering",
    description: "Render and stream your backend tools to the frontend.",
    tags: ["Agent State", "Collaborating"],
  }),
  createFeatureConfig({
    id: "human_in_the_loop",
    name: "Human in the loop",
    description:
      "Plan a task together and direct the Copilot to take the right steps",
    tags: ["HITL", "Interactivity"],
  }),
  createFeatureConfig({
    id: "interrupt",
    name: "Interrupt (Suspend/Resume)",
    description:
      "Agent suspends a tool mid-execution to ask the user, then resumes",
    tags: ["HITL", "Interactivity", "Interrupt"],
  }),
  createFeatureConfig({
    id: "agentic_generative_ui",
    name: "Agentic Generative UI",
    description:
      "Assign a long running task to your Copilot and see how it performs!",
    tags: ["Generative ui (agent)", "Long running task"],
  }),
  createFeatureConfig({
    id: "tool_based_generative_ui",
    name: "Tool Based Generative UI",
    description: "Haiku generator that uses tool based generative UI.",
    tags: ["Generative ui (action)", "Tools"],
  }),
  createFeatureConfig({
    id: "shared_state",
    name: "Shared State between agent and UI",
    description: "A recipe Copilot which reads and updates collaboratively",
    tags: ["Agent State", "Collaborating"],
  }),
  createFeatureConfig({
    id: "predictive_state_updates",
    name: "Predictive State Updates",
    description:
      "Use collaboration to edit a document in real time with your Copilot",
    tags: ["State", "Streaming", "Tools"],
  }),
  createFeatureConfig({
    id: "agentic_chat_reasoning",
    name: "Agentic Chat Reasoning",
    description: "Chat with a reasoning Copilot and call frontend tools",
    tags: ["Chat", "Tools", "Streaming", "Reasoning"],
  }),
  createFeatureConfig({
    id: "agentic_chat_multimodal",
    name: "Agentic Chat Multimodal",
    description: "Chat with a Copilot using images and other media",
    tags: ["Chat", "Multimodal", "Streaming"],
  }),
  createFeatureConfig({
    id: "subgraphs",
    name: "Subgraphs",
    description:
      "Have your tasks performed by multiple agents, working together",
    tags: ["Chat", "Multi-agent architecture", "Streaming", "Subgraphs"],
  }),
  createFeatureConfig({
    id: "deepagents_subagents",
    name: "Deepagents Subagents",
    description:
      "A deepagents supervisor delegates to a research subagent that pauses for your approval mid-task; its messages group under one card keyed by subagentRunId",
    tags: ["Chat", "Multi-agent architecture", "Streaming", "Subagents"],
  }),
  createFeatureConfig({
    id: "a2a_chat",
    name: "A2A Chat",
    description: "Chat with your Copilot and call frontend tools",
    tags: ["Chat", "Tools", "Streaming"],
  }),
  createFeatureConfig({
    id: "vnext_chat",
    name: "VNext Chat",
    description: "Chat based on CopilotKit vnext",
    tags: ["Chat", "VNext", "Streaming"],
  }),
  createFeatureConfig({
    id: "a2ui_fixed_schema",
    name: "A2UI Fixed Schema",
    description:
      "Fixed-schema A2UI flight search with data-bound cards (no streaming)",
    tags: ["A2UI", "Generative UI", "Fixed Schema"],
  }),
  createFeatureConfig({
    id: "a2ui_dynamic_schema",
    name: "A2UI Dynamic Schema",
    description:
      "Dynamic LLM-generated A2UI surfaces from conversation context",
    tags: ["A2UI", "Generative UI", "Dynamic Schema", "Streaming"],
  }),
  createFeatureConfig({
    id: "a2ui_advanced",
    name: "A2UI Advanced",
    description:
      "Dynamic A2UI with custom progress renderer and frontend action handlers",
    tags: ["A2UI", "Advanced", "Progress", "Action Handlers"],
  }),
  createFeatureConfig({
    id: "background_agents",
    name: "Background Agents",
    description:
      "Dispatch long-running work as a Mastra background task and watch its progress render as a distinct activity.",
    tags: ["Background Tasks", "Activity", "Long running task"],
  }),
  createFeatureConfig({
    id: "observational_memory",
    name: "Observational Memory",
    description:
      "Watch Mastra Observational Memory observe and compress the conversation in the background, surfaced as a distinct activity.",
    tags: ["Observational Memory", "Activity", "Memory"],
  }),
  createFeatureConfig({
    id: "a2ui_recovery",
    name: "A2UI Error Recovery",
    description:
      "Automatic A2UI error recovery — invalid surfaces are regenerated (no wipe), with a tasteful hard-failure fallback",
    tags: ["A2UI", "Error Recovery", "Streaming"],
  }),
  createFeatureConfig({
    id: "crew_chat",
    name: "Crew Chat",
    description: "Chat with a CrewAI crew wrapped in a dict-state chat flow",
    tags: ["Chat", "CrewAI", "Streaming"],
  }),
  createFeatureConfig({
    id: "error_flow",
    name: "Error Flow",
    description:
      "Backend flow that raises an error, surfaced to the client as a RunErrorEvent",
    tags: ["CrewAI", "Error Handling"],
  }),
];

export default featureConfig;
