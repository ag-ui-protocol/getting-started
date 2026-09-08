/**
 * aimock fixtures for the deepagents_subagents demo (langgraph-fastapi).
 *
 * The flow makes four model calls, two per agent:
 *
 *   supervisor  -> task(subagent_type="research_assistant", ...)
 *   subagent    -> request_human_approval(answer_summary=...)   [interrupt()]
 *   subagent    -> final answer (branches on the APPROVED/REJECTED tool result)
 *   supervisor  -> relays the subagent's answer
 *
 * Predicates are scoped to phrases unique to this demo's system prompts
 * ("research supervisor with one specialist subagent" / "You are a research
 * assistant") so they never intercept another demo. The subagent's second call
 * is disambiguated from its first by the request_human_approval ToolMessage the
 * resume injects — its content (the APPROVED/REJECTED instruction written by
 * the demo's tool) also selects the approve/reject response deterministically.
 * Only the first subagent call additionally requires the request_human_approval
 * tool to be offered; the post-resume call is matched on the tool result alone,
 * so it does not depend on the tool list surviving the resume.
 *
 * Register via `registerDeepagentsSubagentsFixtures(mockServer)` from
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

const lastToolText = (messages: ChatMessage[] = []): string => {
  const tool = messages.filter((m) => m.role === "tool").pop();
  return textOf(tool?.content);
};

const isSupervisor = (req: ChatCompletionRequest) =>
  /research supervisor with one specialist subagent/i.test(
    systemText(req.messages),
  );

const isResearchAssistant = (req: ChatCompletionRequest) =>
  /You are a research assistant/i.test(systemText(req.messages));

const canRequestApproval = (req: ChatCompletionRequest) =>
  !!req.tools?.some((t) => t.function.name === "request_human_approval");

/**
 * True for the turns this file answers that END IN A TOOL RESULT — the
 * subagent's post-approval reply and the supervisor's relay.
 *
 * aimock's generic "tool result -> generic acknowledgment" fixture in
 * aimock-setup.ts is PREPENDED (position 0), so it outranks anything
 * registered here no matter the order. Demos that answer their own
 * tool-result turns opt out there via this predicate; without it both of this
 * demo's second-round calls get "Done! I've completed that for you." and the
 * approve/reject branches become indistinguishable.
 */
export const deepagentsSubagentsAnswersToolResultTurn = (req: {
  messages?: ChatMessage[];
}): boolean => {
  const messages = req.messages ?? [];
  return (
    isSupervisor({ messages } as ChatCompletionRequest) ||
    isResearchAssistant({ messages } as ChatCompletionRequest)
  );
};

export const SUBAGENT_DRAFT_SUMMARY =
  "The sky appears blue because of Rayleigh scattering.";
export const SUBAGENT_FINAL_ANSWER =
  "The sky appears blue because of Rayleigh scattering: shorter blue wavelengths of sunlight scatter more than other colors.";
export const SUBAGENT_REJECTED_REPLY =
  "You rejected my draft answer. Would you like me to revise it?";
export const SUPERVISOR_RELAY =
  "The research assistant reports: the sky appears blue because of Rayleigh scattering.";

export function registerDeepagentsSubagentsFixtures(mockServer: LLMock): void {
  // 1. Supervisor delegates. Matched before the relay fixture below by the
  //    absence of a task ToolMessage in the transcript.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isSupervisor(req) && !req.messages.some((m) => m.role === "tool"),
    },
    response: {
      toolCalls: [
        {
          name: "task",
          arguments: JSON.stringify({
            subagent_type: "research_assistant",
            description: "Why is the sky blue?",
          }),
        },
      ],
    },
  });

  // 2. Subagent asks for approval (this is what interrupt()s the run).
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isResearchAssistant(req) &&
        canRequestApproval(req) &&
        !/APPROVED|REJECTED/.test(lastToolText(req.messages)),
    },
    response: {
      toolCalls: [
        {
          name: "request_human_approval",
          arguments: JSON.stringify({ answer_summary: SUBAGENT_DRAFT_SUMMARY }),
        },
      ],
    },
  });

  // 3a. Approved: the subagent presents the final answer.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isResearchAssistant(req) && /APPROVED/.test(lastToolText(req.messages)),
    },
    response: { content: SUBAGENT_FINAL_ANSWER },
  });

  // 3b. Rejected: the subagent withholds the answer, per its instructions.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isResearchAssistant(req) && /REJECTED/.test(lastToolText(req.messages)),
    },
    response: { content: SUBAGENT_REJECTED_REPLY },
  });

  // 4. Supervisor relays once the task ToolMessage is back.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isSupervisor(req) && req.messages.some((m) => m.role === "tool"),
    },
    response: { content: SUPERVISOR_RELAY },
  });
}
