import { test } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[OpenAI Agents Python] Agentic Chat sends and receives a greeting message", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hi");
  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
});

test("[OpenAI Agents Python] Agentic Chat retains memory of previous questions", async ({
  page,
}) => {
  test.slow();
  await page.goto("/openai-agents-python/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hi, my name is Alex");
  await chat.assertUserMessageVisible("Hi, my name is Alex");
  await chat.assertAgentReplyVisible(/Hello|Hi|Alex/i);
  await chat.sendMessage("What is my name?");
  await chat.assertUserMessageVisible("What is my name?");
  await chat.assertAgentReplyVisible(/Alex/i);
});

test("[OpenAI Agents Python] Agentic Chat retains user messages during a conversation", async ({
  page,
}) => {
  test.slow();
  await page.goto("/openai-agents-python/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hey there");
  await chat.assertAgentReplyVisible(/Hello|Hi/i);
  await chat.sendMessage("My favorite fruit is Mango");
  await chat.assertAgentReplyVisible(/Mango/i);
  await chat.sendMessage("and I love listening to Kaavish");
  await chat.assertAgentReplyVisible(/Kaavish/i);
  await chat.sendMessage("Can you remind me what my favorite fruit is?");
  await chat.assertAgentReplyVisible(/Mango/i);
});
