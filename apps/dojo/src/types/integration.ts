import type { menuIntegrations } from "../menu";

export type Feature =
  | "agentic_chat"
  | "agentic_generative_ui"
  | "human_in_the_loop"
  | "interrupt"
  | "predictive_state_updates"
  | "shared_state"
  | "tool_based_generative_ui"
  | "backend_tool_rendering"
  | "agentic_chat_reasoning"
  | "agentic_chat_multimodal"
  | "subgraphs"
  | "deepagents_subagents"
  | "a2a_chat"
  | "vnext_chat"
  | "v1_agentic_chat"
  | "a2ui_fixed_schema"
  | "a2ui_dynamic_schema"
  | "a2ui_advanced"
  | "a2ui_recovery"
  | "crew_chat"
  | "error_flow"
  | "background_agents"
  | "observational_memory";

export interface MenuIntegrationConfig {
  id: string;
  name: string;
  features: Feature[];
}

/**
 * Helper type to extract features for a specific integration from menu config
 */
type IntegrationFeature<
  T extends readonly MenuIntegrationConfig[],
  Id extends string,
> = Extract<T[number], { id: Id }>["features"][number];

/** Type representing all valid integration IDs */
export type IntegrationId = (typeof menuIntegrations)[number]["id"];

/** Type to get features for a specific integration ID */
export type FeatureFor<Id extends IntegrationId> = IntegrationFeature<
  typeof menuIntegrations,
  Id
>;
