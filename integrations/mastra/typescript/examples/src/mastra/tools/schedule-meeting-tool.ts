import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Backend tool that suspends its own execution (Mastra's native HITL
// primitive). When `suspend()` is called the @ag-ui/mastra bridge emits a
// CUSTOM `on_interrupt` event; CopilotKit's v2 `useInterrupt` renders the
// picker and resumes the tool with the user's choice via `resumeData`.
export const scheduleMeetingTool = createTool({
  id: "schedule-meeting",
  description:
    "Ask the user to pick a meeting time. Surfaces an in-chat time picker " +
    "and returns the user's selection so the agent can confirm.",
  inputSchema: z.object({
    topic: z.string().describe("Short description of the meeting purpose"),
    attendee: z.string().optional().describe("Who the meeting is with"),
  }),
  // What the frontend receives on suspend (read by the interrupt renderer).
  suspendSchema: z.object({
    topic: z.string(),
    attendee: z.string().optional(),
  }),
  // What the frontend sends back to resume the tool.
  resumeSchema: z.object({
    chosen_time: z.string().optional(),
    chosen_label: z.string().optional(),
    cancelled: z.boolean().optional(),
  }),
  execute: async (inputData, context) => {
    const { resumeData, suspend } = context?.agent ?? {};

    // First execution: pause and ask the user to pick a time. Return the
    // `suspend()` call directly — it keeps the tool suspended so Mastra pauses
    // the run at `tool-call-suspended`. Do NOT `await` then return a value:
    // that completes the tool and the agent continues without the user.
    if (!resumeData) {
      return suspend?.({
        topic: inputData.topic,
        attendee: inputData.attendee,
      });
    }

    // Resumed: the user has responded.
    if (resumeData.cancelled) {
      return `User cancelled. Meeting NOT scheduled: ${inputData.topic}`;
    }
    const label = resumeData.chosen_label ?? resumeData.chosen_time;
    return label
      ? `Meeting scheduled for ${label}: ${inputData.topic}`
      : `User did not pick a time. Meeting NOT scheduled: ${inputData.topic}`;
  },
});
