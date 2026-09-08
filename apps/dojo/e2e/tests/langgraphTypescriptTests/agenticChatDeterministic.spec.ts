import { test, expect } from "../../event-trace-test";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { MockAgent } from "../../lib/mock-agent";
import { agenticChatDeterministicEventTrace } from "./agenticChatDeterministic.event-trace";

/**
 * Deterministic versions of the flaky agentic chat tests.
 *
 * These tests verify UI behavior (background color changes, regenerate)
 * using a mock agent that returns predetermined SSE responses instead of
 * hitting a live LLM. This eliminates flakiness from:
 * - LLM not calling the expected tool
 * - LLM responding too slowly
 * - LLM producing identical output on regenerate
 *
 * The live-LLM versions of these tests still exist in agenticChatPage.spec.ts
 * and test the full integration path. These deterministic tests verify the
 * UI correctly responds to agent events.
 */

test.describe("Deterministic Agentic Chat", () => {
  test("[LangGraph] Background color changes via tool call", async ({
    page,
    eventTrace,
  }) => {
    const mock = new MockAgent(page);

    // Configure deterministic responses for color change requests.
    // { once: true } is required because CopilotKit uses a multi-run pattern
    // for frontend tools: Run 1 delivers the tool call events, CopilotKit
    // executes the handler locally, then makes a follow-up request with the
    // same user message. The follow-up falls through to the fallback.
    mock.onMessage(
      "background color to blue",
      mock.toolCall("change_background", { background: "blue" }),
      { once: true },
    );

    mock.onMessage(
      "background color to pink",
      mock.toolCall("change_background", { background: "pink" }),
      { once: true },
    );

    // Fallback handles CopilotKit's follow-up requests after tool execution
    mock.onAnyMessage(
      mock.textMessage("Done! I've changed the background color for you."),
    );

    await mock.install();

    await page.goto("/langgraph-typescript/feature/agentic_chat");

    const chat = new AgenticChatPage(page);
    await chat.openChat();

    // Get initial background
    const backgroundContainer = page.locator(
      '[data-testid="background-container"]',
    );
    const initialBackground = await backgroundContainer.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    // Send blue color change request
    await chat.sendMessage("Hi change the background color to blue");
    await chat.assertUserMessageVisible(
      "Hi change the background color to blue",
    );

    // Wait for tool call to be processed and background to update
    await expect
      .poll(
        async () => {
          const current = await backgroundContainer.evaluate(
            (el) => getComputedStyle(el).backgroundColor,
          );
          return current !== initialBackground;
        },
        {
          message: "Background color should change after tool call",
          timeout: 30_000,
          intervals: [500, 1000, 2000, 3000],
        },
      )
      .toBeTruthy();

    const blueBackground = await backgroundContainer.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    // Send pink color change request
    await chat.sendMessage("Hi change the background color to pink");
    await chat.assertUserMessageVisible(
      "Hi change the background color to pink",
    );

    await expect
      .poll(
        async () => {
          const current = await backgroundContainer.evaluate(
            (el) => getComputedStyle(el).backgroundColor,
          );
          return current !== blueBackground;
        },
        {
          message: "Background color should change from blue to pink",
          timeout: 30_000,
          intervals: [500, 1000, 2000, 3000],
        },
      )
      .toBeTruthy();

    const pinkBackground = await backgroundContainer.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(pinkBackground).not.toBe(initialBackground);

    await mock.uninstall();
    await eventTrace.expectJourney(
      agenticChatDeterministicEventTrace.backgroundColorChangesViaToolCall,
    );
  });

  // CopilotChat v2 does not wire up onRegenerate to assistant messages,
  // so the regenerate button is not rendered.
  test.skip("[LangGraph] Regenerate produces a new response", async ({
    page,
  }) => {
    const mock = new MockAgent(page);

    const jokes = [
      "Why did the scarecrow win an award? Because he was outstanding in his field!",
      "What do you call a bear with no teeth? A gummy bear!",
    ];

    // First greeting
    mock.onMessage(
      /hello/i,
      mock.textMessage("Hello! How can I help you today?"),
    );

    // Joke request — returns first joke
    mock.onMessage(/joke/i, mock.textMessage(jokes[0]!), { once: true });

    // Name request
    mock.onMessage(/name/i, mock.textMessage("How about the name Alexander?"));

    // Fallback for regeneration — returns a different joke
    mock.onAnyMessage(mock.textMessage(jokes[1]!));

    await mock.install();

    await page.goto("/langgraph-typescript/feature/agentic_chat");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();

    // Send first message
    await chat.sendMessage("Hello agent");
    await page.waitForTimeout(3000);

    // Ask for a joke
    await chat.sendMessage("tell me a joke");
    await page.waitForTimeout(3000);

    const originalJoke = await chat.getAssistantMessageText(2);
    expect(originalJoke.length).toBeGreaterThan(0);

    // Send another message
    await chat.sendMessage("provide a random person's name");
    await page.waitForTimeout(3000);

    // Regenerate the joke
    await chat.regenerateResponse(2);
    await page.waitForTimeout(3000);

    // With mock agent, the regenerated response should be the fallback
    // (different joke), proving the regenerate mechanism works.
    // Unlike live-LLM tests, we CAN assert the text differs because
    // the mock returns deterministic, distinct responses.
    const newJoke = await chat.getAssistantMessageText(2);
    expect(newJoke.length).toBeGreaterThan(0);
    expect(newJoke).not.toBe(originalJoke);

    await mock.uninstall();
  });
});
