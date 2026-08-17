import { test, expect } from "../../event-trace-test";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { agenticChatPageEventTrace } from "./agenticChatPage.event-trace";
import {
  sendChatMessage,
  awaitLLMResponseDone,
} from "../../utils/copilot-actions";

test("[LangGraph] Agentic Chat sends and receives a message", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph-typescript/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am duaa");

  await chat.assertUserMessageVisible("Hi, I am duaa");
  await chat.assertAgentReplyVisible(
    /Hello duaa! How can I assist you today\?/,
  );
  await eventTrace.expectJourney(
    agenticChatPageEventTrace.sendsAndReceivesMessage,
  );
});

test("[LangGraph] Agentic Chat changes background on message and reset", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph-typescript/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  const backgroundContainer = page.locator(
    '[data-testid="background-container"]',
  );
  const getBackground = () =>
    backgroundContainer.evaluate((el) => el.style.background);
  const initialBackground = await getBackground();

  // 1. Send message to change background to blue
  await chat.sendMessage("Hi change the background color to blue", {
    assistantMessagesAdded: 2,
  });
  await chat.assertUserMessageVisible("Hi change the background color to blue");

  await expect.poll(getBackground).not.toBe(initialBackground);
  const backgroundAfterBlue = await getBackground();

  // 2. Change to pink
  await chat.sendMessage("Hi change the background color to pink", {
    assistantMessagesAdded: 2,
  });
  await chat.assertUserMessageVisible("Hi change the background color to pink");

  await expect.poll(getBackground).not.toBe(backgroundAfterBlue);
  await eventTrace.expectJourney(agenticChatPageEventTrace.changesBackground);
});

test("[LangGraph] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph-typescript/feature/agentic_chat");

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.agentGreeting.click();

  await chat.sendMessage("Hey there");
  await chat.assertUserMessageVisible("Hey there");
  await chat.assertAgentReplyVisible(/Hello! How can I assist you today\?/);

  const favFruit = "Mango";
  await chat.sendMessage(`My favorite fruit is ${favFruit}`);
  await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
  await chat.assertAgentReplyVisible(/Mango is a wonderful tropical fruit/);

  await chat.sendMessage("and I love listening to Kaavish");
  await chat.assertUserMessageVisible("and I love listening to Kaavish");
  await chat.assertAgentReplyVisible(/Kaavish is a wonderful musical group/);

  await chat.sendMessage("tell me an interesting fact about Moon");
  await chat.assertUserMessageVisible("tell me an interesting fact about Moon");
  await chat.assertAgentReplyVisible(/Moon is Earth's only natural satellite/);

  await chat.sendMessage("Can you remind me what my favorite fruit is?");
  await chat.assertUserMessageVisible(
    "Can you remind me what my favorite fruit is?",
  );
  await chat.assertAgentReplyVisible(/Your favorite fruit is Mango!/);
  await eventTrace.expectJourney(agenticChatPageEventTrace.retainsMemory);
});
// v2 doesn't support regenerating messages yet, so skipping this test for now
test.skip("[LangGraph Typescript] Agentic Chat regenerates a response", async ({
  page,
}) => {
  await page.goto("/langgraph-typescript/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  // Use sendChatMessage + awaitLLMResponseDone to save time budget
  // vs sendAndAwaitResponse (avoids double-waiting on assistant message count).
  // greeting=0, joke reply=1, filler reply=2
  await sendChatMessage(page, "tell me a joke");
  await awaitLLMResponseDone(page);

  const originalJoke = await chat.getAssistantMessageText(1);

  // Send a filler so the joke is not the last message
  await sendChatMessage(page, "say hello");
  await awaitLLMResponseDone(page);

  // Regenerate the joke response (index 1)
  await chat.regenerateResponse(1);

  await page.waitForFunction(
    () => document.querySelector('[data-copilot-running="false"]') !== null,
    null,
    { timeout: 15000 },
  );

  const newJoke = await chat.getAssistantMessageText(1);
  expect(newJoke.length).toBeGreaterThan(0);
});
