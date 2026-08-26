/**
 * Interrupt example for AWS Strands (TypeScript).
 *
 * Mirrors `python/examples/server/api/interrupt.py`.
 *
 * `schedule_meeting` pauses itself. Strands' native interrupt system lets a tool
 * call `context.interrupt(...)`, which halts the agent loop and finishes the run
 * with `RUN_FINISHED` carrying `outcome.type === "interrupt"`. The dojo's
 * interrupt page renders its time picker, and resuming on the same `threadId`
 * returns the user's choice from that same `interrupt()` call so the tool body
 * continues where it left off.
 *
 * Pause and resume happen on the same live wrapper and process here, so no
 * `SessionManager` is needed. Durable, cross-process resume requires one.
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, runIfMain } from "../run-if-main";

/** What the picker sends back, plus the shape a cancelled resume entry carries. */
interface MeetingChoice {
  chosen_time?: string;
  chosen_label?: string;
  cancelled?: boolean;
  status?: string;
}

const scheduleMeeting = tool({
  name: "schedule_meeting",
  description:
    "Ask the user to pick a meeting time, then confirm what was scheduled.",
  inputSchema: z.object({
    topic: z.string().describe("Short description of the meeting purpose."),
    attendee: z.string().optional().describe("Who the meeting is with."),
  }),
  callback: ({ topic, attendee }, context) => {
    // Typed optional by the SDK, so this is checked rather than asserted: with
    // no context there is nothing to pause on, and pretending otherwise would
    // schedule a meeting the user never saw.
    if (!context) {
      throw new Error("schedule_meeting needs a tool context to pause on");
    }

    const answer = context.interrupt<MeetingChoice>({
      name: "schedule_meeting",
      reason: { topic, attendee },
    });

    // Two cancel shapes reach here: the adapter's own marker for a cancelled
    // resume entry, and the picker's Cancel button, which resolves with a
    // `cancelled` flag. Unlike the Python adapter, this one passes a resolved
    // payload through unwrapped, so the fields are read at the top level.
    if (answer?.cancelled || answer?.status === "cancelled") {
      return `User cancelled. Meeting NOT scheduled: ${topic}`;
    }

    const label = answer?.chosen_label ?? answer?.chosen_time;
    return label
      ? `Meeting scheduled for ${label}: ${topic}`
      : `User did not pick a time. Meeting NOT scheduled: ${topic}`;
  },
});

const SYSTEM_PROMPT = `You are a scheduling assistant.

Whenever the user asks you to book a call or schedule a meeting, you MUST call
the \`schedule_meeting\` tool. Pass a short \`topic\` describing the purpose and,
if known, an \`attendee\` describing who the meeting is with.

The tool pauses execution and shows the user a time picker. Once it resumes with
their choice, briefly confirm whether the meeting was scheduled and at what
time, or note that the user cancelled. Do not ask for approval yourself: always
call the tool and let the picker handle the decision. Keep responses short and
friendly.

Never claim a meeting is scheduled unless the tool result says so.`;

export async function createInterruptAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      model: await createModel(),
      tools: [scheduleMeeting],
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "interrupt",
    description:
      "AWS Strands agent whose scheduling tool pauses for the user to pick a time",
  });
}

runIfMain(import.meta.url, async () => {
  const app = await createStrandsApp(await createInterruptAgent(), {
    path: "/",
  });
  const port = demoPort();
  app.listen(port, () => {
    console.log(`interrupt demo listening on http://localhost:${port}`);
  });
});
