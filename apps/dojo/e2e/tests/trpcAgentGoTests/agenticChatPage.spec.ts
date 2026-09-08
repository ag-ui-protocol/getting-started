import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { blockExternalNetwork } from "./network";

test.beforeEach(async ({ page }) => {
  await blockExternalNetwork(page);
});

test("[tRPC-Agent-Go] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await page.goto("/trpc-agent-go/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am duaa");

  await chat.assertUserMessageVisible("Hi, I am duaa");
  await chat.assertAgentReplyVisible(/Hello/i);
});

test("[tRPC-Agent-Go] Agentic Chat executes a frontend tool", async ({
  page,
}) => {
  await page.goto("/trpc-agent-go/feature/agentic_chat");

  const chat = new AgenticChatPage(page);
  await chat.openChat();

  const backgroundContainer = page.getByTestId("background-container");
  const getBackground = () =>
    backgroundContainer.evaluate((element) => element.style.background);
  const initialBackground = await getBackground();

  await chat.sendMessage("Hi change the background color to blue");

  await chat.assertAgentReplyVisible(/done|completed|changed|background/i);
  await expect.poll(getBackground).not.toBe(initialBackground);
});
