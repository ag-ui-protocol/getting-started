import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[CLI Agent Orchestrator] Agentic Chat sends and receives a response about CAO capabilities", async ({
  page,
}) => {
  await page.goto("/cli-agent-orchestrator/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi");

  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/CLI Agent Orchestrator/i);
});
