import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { scheduleMeetingTool } from "../tools";
import { getStorage } from "../storage";

// Demonstrates Mastra's native suspend/resume HITL bridged onto AG-UI's
// `on_interrupt` flow. The agent calls `schedule_meeting`, which suspends; the
// @ag-ui/mastra adapter emits a CUSTOM `on_interrupt` event; CopilotKit's v2
// `useInterrupt` hook renders a time picker and resumes the tool. Resume works
// for both LOCAL and REMOTE Mastra agents (the remote path round-trips the
// resume over @mastra/client-js' resumeStream, OSS-380), so this is wired for
// both `mastra-agent-local` and the remote `mastra` integration.
export const interruptAgent = new Agent({
  id: "interrupt",
  name: "interrupt",
  instructions: `You are a scheduling assistant. Whenever the user asks you to book a call or schedule a meeting, you MUST call the \`schedule_meeting\` tool. Pass a short \`topic\` describing the purpose and, if known, an \`attendee\` describing who the meeting is with.

The \`schedule_meeting\` tool pauses execution and shows the user a time picker. After it resumes with the user's choice, briefly confirm whether the meeting was scheduled and at what time, or note that the user cancelled. Do not ask for approval yourself — always call the tool and let the picker handle the decision. Keep responses short and friendly.`,
  model: "openai/gpt-4.1-mini",
  // Cast: a tool with concrete suspend/resume schemas is not structurally
  // assignable to Mastra's `ToolAction<..., unknown, unknown, ...>` tools map
  // (generic variance). Runtime behavior is unaffected.
  tools: {
    schedule_meeting: scheduleMeetingTool,
  } as unknown as ConstructorParameters<typeof Agent>[0]["tools"],
  memory: new Memory({
    storage: getStorage(),
  }),
});
