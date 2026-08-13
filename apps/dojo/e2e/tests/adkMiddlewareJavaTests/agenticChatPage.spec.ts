import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const pageURL = "/adk-middleware-java/feature/agentic_chat";

test.describe("Agentic Chat Feature", () => {
  test("[ADK Middleware Java] sends and receives a message", async ({
    page,
  }) => {
    await page.goto(pageURL);

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();
    await chat.sendMessage("Hello, I am duaa.");

    await chat.assertUserMessageVisible("Hello, I am duaa.");
    await chat.assertAgentReplyVisible(/Hello duaa/i);
  });

  test("[ADK Middleware Java] retains memory during a conversation", async ({
    page,
  }) => {
    await page.goto(pageURL);

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();

    await chat.sendMessage("My favorite fruit is Mango");
    await chat.assertUserMessageVisible("My favorite fruit is Mango");

    await chat.sendMessage("Can you remind me what my favorite fruit is?");
    await chat.assertUserMessageVisible(
      "Can you remind me what my favorite fruit is?",
    );
    await chat.assertAgentReplyVisible(/Mango/i);
  });
});
