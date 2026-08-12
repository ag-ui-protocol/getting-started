import assert from "node:assert/strict";
import test from "node:test";

import {
  CREWAI_CONVERSATIONAL_AGENT_PATHS,
  CREWAI_CONVERSATIONAL_FEATURES,
  CREWAI_FLOW_AGENT_PATHS,
  CREWAI_FLOW_FEATURES,
} from "./crewai";
import { menuIntegrations } from "./menu";

const parityFeatures = [
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

test("conversational features match regular Flow parity without regular-only demos", () => {
  assert.deepEqual(CREWAI_CONVERSATIONAL_FEATURES, parityFeatures);
  assert.deepEqual(CREWAI_FLOW_FEATURES, [
    ...parityFeatures,
    "crew_chat",
    "error_flow",
  ]);
});

test("conversational agents use their dedicated backend route prefix", () => {
  for (const [feature, path] of Object.entries(
    CREWAI_CONVERSATIONAL_AGENT_PATHS,
  )) {
    assert.equal(path, `conversational_flows/${feature}`);
  }
  assert.equal(CREWAI_FLOW_AGENT_PATHS.crew_chat, "crew_chat");
  assert.equal(CREWAI_FLOW_AGENT_PATHS.error_flow, "error_flow");
  assert.equal("crew_chat" in CREWAI_CONVERSATIONAL_AGENT_PATHS, false);
  assert.equal("error_flow" in CREWAI_CONVERSATIONAL_AGENT_PATHS, false);
  assert.equal("subgraphs" in CREWAI_FLOW_AGENT_PATHS, false);
  assert.equal("subgraphs" in CREWAI_CONVERSATIONAL_AGENT_PATHS, false);
});

test("dojo exposes separate stable framework identities", () => {
  const regular = menuIntegrations.find(({ id }) => id === "crewai");
  const conversational = menuIntegrations.find(
    ({ id }) => id === "crewai-conversational-flows",
  );

  assert.equal(regular?.name, "CrewAI Flows");
  assert.equal(conversational?.name, "CrewAI Conversational Flows");
  assert.deepEqual(conversational?.features, CREWAI_CONVERSATIONAL_FEATURES);
});
