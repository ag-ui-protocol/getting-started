import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { scheduleMeetingTool } from "../tools/schedule-meeting-tool";

// Demonstrates Mastra's native suspend/resume HITL bridged onto AG-UI's
// `on_interrupt` flow. The agent calls `schedule_meeting`, which suspends; the
// @ag-ui/mastra adapter emits a CUSTOM `on_interrupt` event; CopilotKit's v2
// `useInterrupt` hook renders a time picker and resumes the tool. Resume works
// for both local and remote Mastra agents (the remote path round-trips the
// resume over @mastra/client-js' resumeStream, OSS-380). Remote resume loads
// the suspended snapshot from storage, so the Mastra instance must configure
// instance-level storage (see this server's `mastra` instance).
export const interruptAgent = new Agent({
  id: "interrupt",
  name: "interrupt",
  instructions: `You are a scheduling assistant. Whenever the user asks you to book a call or schedule a meeting, you MUST call the \`schedule_meeting\` tool. Pass a short \`topic\` describing the purpose and, if known, an \`attendee\` describing who the meeting is with.

The \`schedule_meeting\` tool pauses execution and shows the user a time picker. After it resumes with the user's choice, briefly confirm whether the meeting was scheduled and at what time, or note that the user cancelled. Do not ask for approval yourself — always call the tool and let the picker handle the decision. Keep responses short and friendly.`,
  model: "openai/gpt-4.1-mini",
  // Cast: a tool with concrete suspend/resume schemas is not structurally
  // assignable to Mastra's `ToolAction<..., unknown, unknown, ...>` tools map
  // (generic variance). Runtime behavior is unaffected.
  tools: { schedule_meeting: scheduleMeetingTool as any },
  memory: new Memory({
    storage: new LibSQLStore({
      id: "interrupt-memory",
      url: "file:../mastra.db", // path is relative to the .mastra/output directory
    }),
  }),
});
