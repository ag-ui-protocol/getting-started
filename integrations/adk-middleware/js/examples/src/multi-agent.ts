import type { ADKJSSubagentMode } from "@ag-ui/adk-js";
import { Agent, Workflow, type BaseLlm } from "@google/adk";

import { createDojoAgent } from "./factory";

// Match the AWS Strands prompts so the shared Dojo fixtures apply here too.
const RESEARCHER_PROMPT = `
      You are the RESEARCHER in a three-agent pipeline.
      Gather the key facts for the user's topic.
      Reply with 2-3 short bullet points of findings and nothing else.
      Begin every bullet with the exact prefix "Research:".
    `;

const ANALYST_PROMPT = `
      You are the ANALYST in a three-agent pipeline.
      You receive the researcher's findings. Draw out what they imply.
      Reply with 2-3 short bullet points of analysis and nothing else.
      Begin every bullet with the exact prefix "Analysis:".
    `;

const WRITER_PROMPT = `
      You are the WRITER in a three-agent pipeline.
      You receive the analyst's conclusions. Write the final answer for the user.
      Reply with one short paragraph and nothing else.
      Begin your reply with the exact prefix "Summary:".
    `;

/** Each workflow node passes its final text to the next agent. */
export function createMultiAgentAgent(
  options: {
    model?: string | BaseLlm;
    subagents?: ADKJSSubagentMode;
  } = {},
) {
  return createDojoAgent({
    name: "adk_js_multi_agent",
    model: options.model,
    // The Dojo page is driven by the step and handoff events.
    subagents: options.subagents ?? "steps",
    createRoot: (model) =>
      new Workflow({
        name: "adk_js_multi_agent",
        description: "Workflow of researcher, analyst and writer agents",
        edges: [
          [
            "START",
            new Agent({
              name: "researcher",
              description: "Gathers the facts",
              model,
              instruction: RESEARCHER_PROMPT,
            }),
            new Agent({
              name: "analyst",
              description: "Draws out what they imply",
              model,
              instruction: ANALYST_PROMPT,
            }),
            new Agent({
              name: "writer",
              description: "Writes the final answer",
              model,
              instruction: WRITER_PROMPT,
            }),
          ],
        ],
      }),
  });
}
