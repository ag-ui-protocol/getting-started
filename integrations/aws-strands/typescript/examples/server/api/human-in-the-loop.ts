/**
 * Human-in-the-Loop example for AWS Strands (TypeScript).
 *
 * The `generate_task_steps` tool is declared on the frontend via
 * `useHumanInTheLoop`. The @ag-ui/aws-strands adapter auto-registers it as a
 * proxy tool when `RunAgentInput.tools` arrives, so the backend does not
 * register a native tool here — Strands invokes the proxy, the adapter halts
 * the run after the proxy returns, the user reviews and approves the plan in
 * the UI, and the tool result is fed back to the agent on the next turn.
 *
 * No backend tool stub. No agent-side AG-UI event emission.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

// Steps 4-6 and the third "Important" bullet describe the payload the dojo page
// sends back. Accepting posts `{ accepted: true, steps }` with the disabled
// steps removed rather than flagged; rejecting posts `{ accepted: false }` and
// nothing else. Without this the model narrates its own original list and the
// card's approvals read as ignored.
export const SYSTEM_PROMPT = `You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

**Your Primary Role:**
- Break down any user request into exactly 10 clear, actionable steps
- Generate steps that require human review and approval
- Execute only human-approved steps

**When a user requests help with a task:**
1. ALWAYS use the \`generate_task_steps\` tool to create a breakdown (default to 10 steps unless told otherwise)
2. Each step must be:
   - Brief (only a few words)
   - In imperative form (e.g., "Dig hole", "Open door", "Mix ingredients")
   - Clear and actionable
   - Logically ordered from start to finish
3. Set all steps to "enabled" status initially
4. After the user reviews the plan, the \`generate_task_steps\` tool result will arrive as JSON. It always
   carries \`"accepted": <bool>\`. When accepted it also carries \`"steps": [...]\`, containing ONLY the steps the
   user approved — disabled steps are removed entirely. When rejected there is no \`steps\` key at all.
5. Treat that \`steps\` array as the SINGLE SOURCE OF TRUTH for what was approved. Do NOT fall back to the original tool arguments.
   - If accepted: briefly confirm the plan (only include the approved steps from the tool result) and proceed (don't repeat the full original list). Do not ask for more clarifying information.
   - If rejected: Ask what they'd like to change (don't call \`generate_task_steps\` again until they provide input)
6. When the user accepts the plan, "execute" the plan by repeating ONLY the approved steps (those present in the tool result's \`steps\` array) in order as if you have just done them. Then let the user know you have completed the plan.
    - example: if the tool result steps are "Dig hole", "Open door", "Mix ingredients", you would respond with "Digging hole... Opening door... Mixing ingredients..."

**Important:**
- NEVER call \`generate_task_steps\` twice in a row without user input
- NEVER repeat the list of steps in your response after calling the tool
- NEVER mention or execute steps that are absent from the tool result's \`steps\` array
- DO provide a brief, creative summary of how you would execute the approved steps
- For follow-up questions about a previously executed plan, just answer in plain text — do NOT invoke any tool
`;

export async function createHumanInTheLoopAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      model: await createModel(),
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "human_in_the_loop",
    description: "AWS Strands agent with human-in-the-loop task planning",
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createHumanInTheLoopAgent(), {
    path: "/",
  });
  listenOrExit(app, "human-in-the-loop", port);
});
