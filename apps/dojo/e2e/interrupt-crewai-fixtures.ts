/**
 * aimock fixtures for the CrewAI interrupt (suspend/resume) demo.
 *
 * The flow makes TWO model calls around the pause, so both need a fixture:
 *
 * 1. before the pause, it extracts the meeting from the conversation and must
 *    reply with bare JSON (`{"topic": ..., "attendee": ...}`) - that payload is
 *    what the time picker renders;
 * 2. after the resume, it confirms the booking as plain text - that text is the
 *    agent's follow-up in the chat.
 *
 * Both predicates are scoped to phrases unique to this flow's system prompts, so
 * they never intercept the other demos (which match on user text).
 *
 * Register via `registerInterruptCrewAIFixtures(mockServer)` from aimock-setup.ts.
 */
import type { LLMock, ChatMessage } from "@copilotkit/aimock";

const textOf = (content: ChatMessage["content"] | undefined): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("");
  }
  return "";
};

const systemText = (messages: ChatMessage[] = []): string =>
  messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");

export function registerInterruptCrewAIFixtures(mockServer: LLMock): void {
  // Step 1: extract the meeting -> bare JSON the picker reads (topic/attendee).
  mockServer.addFixture({
    match: {
      predicate: (req: any) =>
        /work out which meeting the user wants to book/i.test(
          systemText(req.messages),
        ),
    },
    response: {
      content: JSON.stringify({
        topic: "Intro call to discuss pricing",
        attendee: "sales team",
      }),
    },
  });

  // Step 2: after resume, confirm the booking as the agent's follow-up text.
  mockServer.addFixture({
    match: {
      predicate: (req: any) =>
        /asked the user to pick a meeting time/i.test(systemText(req.messages)),
    },
    response: {
      content:
        "Your intro call with the sales team is booked. Looking forward to it!",
    },
  });
}
