/**
 * Multi-agent example for AWS Strands (TypeScript).
 *
 * Mirrors `python/examples/server/api/multi_agent.py`: a Strands `Graph` of
 * three specialist agents wired in sequence. The adapter drives the
 * orchestrator directly and translates its node lifecycle into AG-UI
 * STEP_STARTED / STEP_FINISHED plus `MultiAgentHandoff` CUSTOM events, so the
 * dojo page can show which node is running and how control moved between them.
 *
 * Node ids are the strings the UI and the end-to-end specs match on, so they
 * must stay in sync with the dojo page. The graph derives each node id from
 * the agent's `id`, not its `name`.
 */

import { Agent } from "@strands-agents/sdk";
import { Graph } from "@strands-agents/sdk/multiagent";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createModel } from "../model-factory";

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

export async function createMultiAgentGraphAgent(): Promise<StrandsAgent> {
  const model = await createModel();

  // Built per run rather than once at startup. An agent rejects overlapping
  // invocations, so a single shared graph turns two concurrent visitors into
  // an error for one of them. Mirrors the Python example, which needs the same
  // treatment for a second reason: a Python Graph also carries node history
  // across executions, where the TypeScript SDK snapshots and restores it.
  const buildGraph = () =>
    new Graph({
      nodes: [
        {
          agent: new Agent({
            model,
            id: "researcher",
            name: "researcher",
            systemPrompt: RESEARCHER_PROMPT,
            printer: false,
          }),
        },
        {
          agent: new Agent({
            model,
            id: "analyst",
            name: "analyst",
            systemPrompt: ANALYST_PROMPT,
            printer: false,
          }),
        },
        {
          agent: new Agent({
            model,
            id: "writer",
            name: "writer",
            systemPrompt: WRITER_PROMPT,
            printer: false,
          }),
        },
      ],
      edges: [
        ["researcher", "analyst"],
        ["analyst", "writer"],
      ],
    });

  // The adapter detects an orchestrator by the absence of a `model` accessor
  // and drives whatever `stream` it is handed, so this stands in for a Graph
  // while keeping runs isolated from one another.
  const perRunGraph = {
    id: "multi_agent_graph",
    // Every argument is forwarded, so a caller passing invocation state or a
    // cancel signal is not silently dropped by the stand-in.
    async *stream(...args: Parameters<Graph["stream"]>) {
      yield* buildGraph().stream(...args);
    },
  };

  return new StrandsAgent({
    agent: perRunGraph,
    name: "multi_agent",
    description: "Strands Graph of researcher, analyst and writer agents",
  });
}
