import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[ADK JavaScript] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/agentic_chat");

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am Duaa");

  await chat.assertUserMessageVisible("Hi, I am Duaa");
  await chat.assertAgentReplyVisible(/Hello Duaa/i);
});
