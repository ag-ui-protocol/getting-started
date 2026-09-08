import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import { getStorage } from "../storage";

// A deliberately slow "research" tool. Flagged background-eligible so Mastra's
// Background Task manager dispatches it out of the agentic loop; its lifecycle
// surfaces on fullStream as background-task-* chunks, which the AG-UI Mastra
// bridge maps to ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events.
const runDeepResearch = createTool({
  id: "run_deep_research",
  description:
    "Run a long deep-research job on a topic. This runs in the background and " +
    "reports progress while the conversation continues. Use it whenever the " +
    "user asks to research, investigate, or dig into a topic.",
  inputSchema: z.object({
    topic: z.string().describe("The topic to research"),
  }),
  outputSchema: z.object({
    topic: z.string(),
    summary: z.string(),
    sources: z.number(),
  }),
  // Background-eligible. The agent config below forces it to actually run in
  // the background and waits long enough for it to finish within the stream.
  background: { enabled: true, waitTimeoutMs: 60_000 },
  execute: async ({ topic }) => {
    // Simulate staged long-running work so progress heartbeats tick.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 800));
    }
    return {
      topic,
      summary: `Completed a deep-research pass on "${topic}": gathered findings, cross-checked sources, and synthesized a summary.`,
      sources: 7,
    };
  },
});

export const backgroundAgentsAgent = new Agent({
  id: "background_agents",
  name: "background_agents",
  instructions: `
    You are a research assistant that dispatches long-running work as background tasks.

    When the user asks you to research, investigate, or look into a topic:
    - Call the \`run_deep_research\` tool with the topic.
    - The tool runs in the background and returns immediately with an
      acknowledgement; it does NOT block. Briefly tell the user you've kicked
      off the research in the background and that they'll get the findings
      shortly. Do not invent findings — the work is still running.

    Keep your text responses short. The heavy lifting happens in the background task.
  `,
  model: "openai/gpt-4.1-mini",
  tools: { run_deep_research: runDeepResearch },
  memory: new Memory({ storage: getStorage() }),
  // Force every background-eligible tool to actually run in the background
  // (don't leave it to the model's per-call choice) so the demo is reliable.
  backgroundTasks: { tools: "all" },
});
