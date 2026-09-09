import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Vercel AI SDK] Agentic Chat sends and receives a greeting message", async ({
  page,
}) => {
  await page.goto("/vercel-ai-sdk/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hey there");

  await chat.assertUserMessageVisible("Hey there");
  await chat.assertAgentReplyVisible(/Hello! How can I assist you today\?/);
});

test("[Vercel AI SDK] Agentic Chat retains memory across turns", async ({
  page,
}) => {
  await page.goto("/vercel-ai-sdk/feature/agentic_chat");

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  await chat.sendMessage("Hello, my name is Alex");
  await chat.assertUserMessageVisible("Hello, my name is Alex");
  await chat.assertAgentReplyVisible(/Hello Alex/);

  await chat.sendMessage("What is my name?");
  await chat.assertUserMessageVisible("What is my name?");
  await chat.assertAgentReplyVisible(/Alex/);
});
