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
 * The resume payload arrives wrapped: a resolved answer as `{ response: ... }`,
 * a client-side cancel as `{ cancelled: true }`. The adapter wraps it so one tool
 * body reads the same on both bridges, and because an answer the SDK reads as
 * absent would re-raise the same interrupt forever.
 *
 * Pause and resume happen on the same live wrapper and process here, so no
 * `SessionManager` is needed. Durable, cross-process resume requires one.
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

/** What the picker sends back. */
interface MeetingChoice {
  chosen_time?: string;
  chosen_label?: string;
  cancelled?: boolean;
}

/** The envelope the adapter hands a resumed tool. */
interface ResumeEnvelope {
  /** `null` when the client answered with no payload at all. */
  response?: MeetingChoice | null;
  cancelled?: boolean;
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

    // `attendee` is optional, and the reason has to be JSON, which has no
    // `undefined`. Omitted rather than sent as undefined so the picker sees the
    // field missing instead of present-and-empty.
    const answer = context.interrupt<ResumeEnvelope>({
      name: "schedule_meeting",
      reason: attendee === undefined ? { topic } : { topic, attendee },
    });

    // Two cancel shapes reach here: the adapter's sentinel for a cancelled
    // resume entry, and the picker's own Cancel button, which resolves with a
    // `cancelled` flag inside the payload.
    //
    // The answer is whatever the client sent, so it need not be an object at
    // all. Checked rather than assumed, and checked the same way the Python
    // example does: reading fields off a bare string or number silently yields
    // nothing here and raises there, which is the two demos disagreeing about
    // the same input.
    const inner = answer?.response;
    const payload: MeetingChoice =
      inner && typeof inner === "object" ? inner : {};
    if (answer?.cancelled || payload.cancelled) {
      return `User cancelled. Meeting NOT scheduled: ${topic}`;
    }

    const label = payload.chosen_label ?? payload.chosen_time;
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
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createInterruptAgent(), {
    path: "/",
  });
  listenOrExit(app, "interrupt", port);
});
