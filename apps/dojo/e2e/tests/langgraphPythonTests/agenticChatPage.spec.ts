import { test, expect } from "../../event-trace-test";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { agenticChatPageEventTrace } from "./agenticChatPage.event-trace";

test("[LangGraph] Agentic Chat sends and receives a message", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am duaa");

  await chat.assertUserMessageVisible("Hi, I am duaa");
  await chat.assertAgentReplyVisible(
    /Hello|Hi|Hey|Greetings|nice to meet|welcome/i,
  );
  await eventTrace.expectJourney(
    agenticChatPageEventTrace.sendsAndReceivesMessage,
  );
});

test("[LangGraph] Agentic Chat changes background on message and reset", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph/feature/agentic_chat");

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

  // Wait for the full tool-execution cycle to complete (tool call + follow-up).
  // awaitLLMResponseDone can return prematurely if data-copilot-running briefly
  // flips to false between the two agent runs, so also wait for the agent's
  // text reply and background change which prove the cycle fully finished.
  await chat.assertAgentReplyVisible(/done|completed|changed|background/i);
  await expect.poll(getBackground).not.toBe(initialBackground);
  const backgroundAfterBlue = await getBackground();

  // 2. Change to pink
  await chat.sendMessage("Hi change the background color to pink", {
    assistantMessagesAdded: 2,
  });
  await chat.assertUserMessageVisible("Hi change the background color to pink");
  await chat.assertAgentReplyVisible(/done|completed|changed|background/i);
  await expect.poll(getBackground).not.toBe(backgroundAfterBlue);
  const backgroundAfterPink = await getBackground();
  // Verify it also differs from initial (not a reset)
  expect(backgroundAfterPink).not.toBe(initialBackground);
  await eventTrace.expectJourney(agenticChatPageEventTrace.changesBackground);
});

test("[LangGraph] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph/feature/agentic_chat");

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.agentGreeting.click();

  await chat.sendMessage("Hey there");
  await chat.assertUserMessageVisible("Hey there");
  await chat.assertAgentReplyVisible(
    /how can I|help|assist|what can I do|what would you like/i,
  );

  const favFruit = "Mango";
  await chat.sendMessage(`My favorite fruit is ${favFruit}`);
  await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
  await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));

  await chat.sendMessage("and I love listening to Kaavish");
  await chat.assertUserMessageVisible("and I love listening to Kaavish");
  await chat.assertAgentReplyVisible(/Kaavish/i);

  await chat.sendMessage("tell me an interesting fact about Moon");
  await chat.assertUserMessageVisible("tell me an interesting fact about Moon");
  await chat.assertAgentReplyVisible(/Moon/i);

  await chat.sendMessage("Can you remind me what my favorite fruit is?");
  await chat.assertUserMessageVisible(
    "Can you remind me what my favorite fruit is?",
  );
  await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
  await eventTrace.expectJourney(agenticChatPageEventTrace.retainsMemory);
});

// Skip: CopilotChat v2 does not wire up onRegenerate to assistant messages,
// so the regenerate button is not rendered. Requires framework-level change.
test.skip("[LangGraph] Agentic Chat regenerates a response", async ({
  page,
}) => {
  await page.goto("/langgraph/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  // Send messages using page object (now uses sendChatMessage + awaitLLMResponseDone)
  await chat.sendMessage("tell me a joke");

  // Greeting is not a copilot-assistant-message, so joke reply is at index 0
  const jokeIndex = 0;
  await chat.getAssistantMessageText(jokeIndex);

  // Send a filler so the joke is not the last message
  await chat.sendMessage("say hello");

  // Regenerate the joke response
  await chat.regenerateResponse(jokeIndex);

  await page.waitForFunction(
    () => document.querySelector('[data-copilot-running="false"]') !== null,
    null,
    { timeout: 15000 },
  );

  const newJoke = await chat.getAssistantMessageText(jokeIndex);
  expect(newJoke.length).toBeGreaterThan(0);
});
