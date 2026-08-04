import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[CrewAI] Crew Chat sends and receives a message (dict state path)", async ({
  page,
}) => {
  await page.goto("/crewai/feature/crew_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hello from crew test");

  await chat.assertUserMessageVisible("Hello from crew test");
  await chat.assertAgentReplyVisible(/crew chat assistant/i);
});

test("[CrewAI] Crew Chat handles follow-up messages (dict state path)", async ({
  page,
}) => {
  await page.goto("/crewai/feature/crew_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage("Hello from crew test");
  await chat.assertUserMessageVisible("Hello from crew test");
  await chat.assertAgentReplyVisible(/crew chat assistant/i);

  await chat.sendMessage("What is 2 plus 2");
  await chat.assertUserMessageVisible("What is 2 plus 2");
  await chat.assertAgentReplyVisible(/equals 4/i);
});

test("[CrewAI] Crew Chat handles crew_exit tool call (dict state path)", async ({
  page,
}) => {
  await page.goto("/crewai/feature/crew_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage("goodbye crew");
  await chat.assertUserMessageVisible("goodbye crew");
  await chat.assertAgentReplyVisible(/crew has been shut down/i);
});

// CPK-7717 defect 2 (P0): after a BACKEND crew tool result, the assistant must
// still SPEAK. This drives the full crew-tool path end-to-end — user message →
// assistant calls the crew tool ("CrewChatCrew") → ChatWithCrewFlow runs
// crew.kickoff() → the assistant issues the follow-up completion and replies in
// text about the result. The pre-fix single-pass chat() left the assistant
// silent after the crew ran (only the crew_exit branch had a follow-up), so the
// visible follow-up text is exactly what proves the fix. The crew tool call, the
// kickoff, and its internal agent LLM call are all real — only the LLM is mocked
// (see the crew-RUN fixtures in aimock-setup.ts).
test("[CrewAI] Crew Chat speaks after running the crew tool (defect 2)", async ({
  page,
}) => {
  await page.goto("/crewai/feature/crew_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage("Ask the crew to plan a team offsite");
  await chat.assertUserMessageVisible("Ask the crew to plan a team offsite");

  // The assistant must produce visible follow-up TEXT after the crew tool ran
  // (not merely emit the tool call). This is the defect-2 proof.
  await chat.assertAgentReplyVisible(/crew finished planning your team offsite/i);
});
