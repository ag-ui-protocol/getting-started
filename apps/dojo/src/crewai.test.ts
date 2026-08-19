import assert from "node:assert/strict";
import test from "node:test";

import {
  CREWAI_CONVERSATIONAL_AGENT_PATHS,
  CREWAI_CONVERSATIONAL_FEATURES,
  CREWAI_FLOW_AGENT_PATHS,
  CREWAI_FLOW_FEATURES,
} from "./crewai";
import { menuIntegrations } from "./menu";

const REGULAR_ONLY_FEATURES = ["crew_chat", "error_flow"] as const;

test("regular Flow features are the canonical CrewAI surface", () => {
  assert.deepEqual(CREWAI_FLOW_FEATURES, [
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
    ...REGULAR_ONLY_FEATURES,
  ]);
});

test("conversational features are a curated subset of the regular surface", () => {
  const flowFeatures = new Set<string>(CREWAI_FLOW_FEATURES);
  for (const feature of CREWAI_CONVERSATIONAL_FEATURES) {
    assert.equal(flowFeatures.has(feature), true, feature);
  }

  const conversationalFeatures = new Set<string>(CREWAI_CONVERSATIONAL_FEATURES);
  const regularOnly = CREWAI_FLOW_FEATURES.filter(
    (feature) => !conversationalFeatures.has(feature),
  );
  assert.deepEqual(regularOnly, [...REGULAR_ONLY_FEATURES]);
});

// Pinned literals, NOT derived from the implementation: these are the paths
// `ag_ui_crewai/dojo.py` actually registers, so a typo'd or renamed route has
// to fail here rather than ship a 404. A re-added `subgraphs` route also fails
// these, on top of being a compile error via the `satisfies` clause.
// This is a hand-maintained mirror of the backend; the Python side asserts the
// same route set against the live FastAPI app, so a rename has to update both.
const EXPECTED_FLOW_ROUTES: Record<string, string> = {
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
};

// Also pinned rather than derived. `dojo.py` builds these from the FEATURE key
// (`/conversational_flows/{feature}`), not from the regular route value, so
// deriving them here would hide a divergence between the two.
const EXPECTED_CONVERSATIONAL_ROUTES: Record<string, string> = {
  agentic_chat: "conversational_flows/agentic_chat",
  agentic_chat_reasoning: "conversational_flows/agentic_chat_reasoning",
  agentic_chat_multimodal: "conversational_flows/agentic_chat_multimodal",
  backend_tool_rendering: "conversational_flows/backend_tool_rendering",
  interrupt: "conversational_flows/interrupt",
  human_in_the_loop: "conversational_flows/human_in_the_loop",
  tool_based_generative_ui: "conversational_flows/tool_based_generative_ui",
  agentic_generative_ui: "conversational_flows/agentic_generative_ui",
  shared_state: "conversational_flows/shared_state",
  predictive_state_updates: "conversational_flows/predictive_state_updates",
  a2ui_dynamic_schema: "conversational_flows/a2ui_dynamic_schema",
  a2ui_recovery: "conversational_flows/a2ui_recovery",
  a2ui_fixed_schema: "conversational_flows/a2ui_fixed_schema",
};

test("regular Flow routes match the backend paths the dojo registers", () => {
  assert.deepEqual(CREWAI_FLOW_AGENT_PATHS, EXPECTED_FLOW_ROUTES);
});

test("conversational agents use their dedicated backend route prefix", () => {
  assert.deepEqual(
    CREWAI_CONVERSATIONAL_AGENT_PATHS,
    EXPECTED_CONVERSATIONAL_ROUTES,
  );
});

test("only v1_agentic_chat may advertise a feature with no agent path", () => {
  // v1_agentic_chat reuses the agentic_chat route from its own page, so it is
  // the single legitimate feature without an entry. Any other gap would ship a
  // menu cell that resolves to no agent at runtime.
  const flowPaths = CREWAI_FLOW_AGENT_PATHS as Record<string, string>;
  const missing = CREWAI_FLOW_FEATURES.filter(
    (feature) => !(feature in flowPaths),
  );

  assert.deepEqual(missing, ["v1_agentic_chat"]);
});

test("dojo exposes separate stable framework identities", () => {
  const regular = menuIntegrations.find(({ id }) => id === "crewai");
  const conversational = menuIntegrations.find(
    ({ id }) => id === "crewai-conversational-flows",
  );

  assert.equal(regular?.name, "CrewAI Flows");
  assert.equal(conversational?.name, "CrewAI Conversational Flows");
  assert.deepEqual(regular?.features, CREWAI_FLOW_FEATURES);
  assert.deepEqual(conversational?.features, CREWAI_CONVERSATIONAL_FEATURES);
});
