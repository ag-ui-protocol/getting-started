export const CREWAI_CONVERSATIONAL_FEATURES = [
  "agentic_chat",
  "agentic_chat_reasoning",
  "agentic_chat_multimodal",
  "v1_agentic_chat",
  "backend_tool_rendering",
  "interrupt",
  "human_in_the_loop",
  "agentic_generative_ui",
  "predictive_state_updates",
  "shared_state",
  "tool_based_generative_ui",
  "a2ui_dynamic_schema",
  "a2ui_recovery",
  "a2ui_fixed_schema",
] as const;

export const CREWAI_FLOW_FEATURES = [
  ...CREWAI_CONVERSATIONAL_FEATURES,
  "crew_chat",
  "error_flow",
] as const;

export const CREWAI_FLOW_AGENT_PATHS = {
  agentic_chat: "agentic_chat",
  agentic_chat_reasoning: "agentic_chat_reasoning",
  agentic_chat_multimodal: "agentic_chat_multimodal",
  backend_tool_rendering: "backend_tool_rendering",
  interrupt: "interrupt",
  human_in_the_loop: "human_in_the_loop",
  tool_based_generative_ui: "tool_based_generative_ui",
  agentic_generative_ui: "agentic_generative_ui",
  shared_state: "shared_state",
  predictive_state_updates: "predictive_state_updates",
  crew_chat: "crew_chat",
  error_flow: "error_flow",
  a2ui_dynamic_schema: "a2ui_dynamic_schema",
  a2ui_recovery: "a2ui_recovery",
  a2ui_fixed_schema: "a2ui_fixed_schema",
} as const;

export const CREWAI_CONVERSATIONAL_AGENT_PATHS = Object.fromEntries(
  Object.entries(CREWAI_FLOW_AGENT_PATHS)
    .filter(([feature]) => feature !== "crew_chat" && feature !== "error_flow")
    .map(([feature, path]) => [feature, `conversational_flows/${path}`]),
) as {
  [K in Exclude<
    keyof typeof CREWAI_FLOW_AGENT_PATHS,
    "crew_chat" | "error_flow"
  >]: `conversational_flows/${(typeof CREWAI_FLOW_AGENT_PATHS)[K]}`;
};
