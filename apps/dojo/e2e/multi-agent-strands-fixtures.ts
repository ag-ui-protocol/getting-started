/**
 * aimock fixtures for the AWS Strands multi-agent (Graph) demo.
 *
 * The graph makes one model call per node, so each node needs its own fixture.
 * Each predicate is scoped to a phrase unique to that node's system prompt, so
 * they never intercept another demo (which match on user text or their own
 * system prompts), and the three fire in graph order as the run progresses:
 *
 *   researcher -> analyst -> writer
 *
 * Both example servers describe each node with the same wording (indentation
 * aside), so one set of fixtures drives both.
 *
 * Register via `registerMultiAgentStrandsFixtures(mockServer)` from
 * aimock-setup.ts.
 */
import type {
  LLMock,
  ChatMessage,
  ChatCompletionRequest,
} from "@copilotkit/aimock";

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

export function registerMultiAgentStrandsFixtures(mockServer: LLMock): void {
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        /You are the RESEARCHER in a three-agent pipeline/i.test(
          systemText(req.messages),
        ),
    },
    response: {
      content:
        "Research: remote work cuts commute time to zero.\n" +
        "Research: teams report longer stretches of focused work.\n" +
        "Research: onboarding takes deliberate effort.",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        /You are the ANALYST in a three-agent pipeline/i.test(
          systemText(req.messages),
        ),
    },
    response: {
      content:
        "Analysis: the time saved is real but unevenly distributed.\n" +
        "Analysis: focus gains depend on meeting discipline.\n" +
        "Analysis: onboarding is the cost centre to watch.",
    },
  });

  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        /You are the WRITER in a three-agent pipeline/i.test(
          systemText(req.messages),
        ),
    },
    response: {
      content:
        "Summary: remote work reliably returns commute time and protects " +
        "focus when meetings are kept in check, but it moves the cost onto " +
        "onboarding, which has to be designed rather than assumed.",
    },
  });
}
