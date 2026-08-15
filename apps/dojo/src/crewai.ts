/**
 * Regular CrewAI Flows are the canonical dojo surface for this integration.
 * Conversational Flows are a curated subset of it, so this list leads and the
 * conversational one is derived from it by hand.
 */
export const CREWAI_FLOW_FEATURES = [
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
  "crew_chat",
  "error_flow",
] as const;

export type CrewAIFlowFeature = (typeof CREWAI_FLOW_FEATURES)[number];

/**
 * Curated subset of the regular Flow surface that has a conversational
 * counterpart. `crew_chat` serves a bare Crew rather than a Flow, and
 * `error_flow` covers the endpoint's error path, so neither has one.
 *
 * The `satisfies` clause makes an entry that is not a regular Flow feature a
 * compile error, so the subset cannot silently drift into a superset.
 */
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
] as const satisfies readonly CrewAIFlowFeature[];

export type CrewAIConversationalFeature =
  (typeof CREWAI_CONVERSATIONAL_FEATURES)[number];

/**
 * Backend route per feature. `Partial` is deliberate: `v1_agentic_chat` has no
 * route of its own because its page targets the `agentic_chat` agent directly.
 * It is the only permitted omission, which `crewai.test.ts` pins.
 */
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
} as const satisfies Partial<Record<CrewAIFlowFeature, string>>;

const CONVERSATIONAL_FEATURE_SET: ReadonlySet<string> = new Set(
  CREWAI_CONVERSATIONAL_FEATURES,
);

// Derived from the route map, so `v1_agentic_chat` drops out here as it has no
// route of its own. That matches the backend, which registers a conversational
// route only for the features in CONVERSATIONAL_FLOW_TYPES.

export const CREWAI_CONVERSATIONAL_AGENT_PATHS = Object.fromEntries(
  Object.entries(CREWAI_FLOW_AGENT_PATHS)
    .filter(([feature]) => CONVERSATIONAL_FEATURE_SET.has(feature))
    .map(([feature, path]) => [feature, `conversational_flows/${path}`]),
) as {
  [K in Extract<
    keyof typeof CREWAI_FLOW_AGENT_PATHS,
    CrewAIConversationalFeature
  >]: `conversational_flows/${(typeof CREWAI_FLOW_AGENT_PATHS)[K]}`;
};
