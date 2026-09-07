import { test, expect } from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

test.describe("[Integration] AWS Strands - Agentic Chat Citations", () => {
  test("attaches the answer's sources to the message that used them", async ({
    page,
  }) => {
    await page.goto("/aws-strands/feature/agentic_chat_citations");
    await openChat(page);

    // The panel starts empty, so a later assertion that it has content cannot
    // pass on something that was already there.
    await expect(page.getByTestId("citations-empty")).toBeVisible();

    await sendChatMessage(
      page,
      "How does HTTP/3 differ from HTTP/2? Search the web.",
    );
    await awaitLLMResponseDone(page);

    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).not.toBeEmpty({ timeout: 30000 });

    // The panel reads assistant message metadata, so anything it renders came
    // off the message rather than off a separate event.
    await expect(page.getByTestId("citations-empty")).toBeHidden({
      timeout: 30000,
    });
    const items = page.getByTestId("citation-item");
    await expect(items.first()).toBeVisible({ timeout: 30000 });

    // A citation that names no source is dropped by the adapter, so every item
    // rendered here must carry a title.
    const titles = page.getByTestId("citation-title");
    const count = await titles.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(titles.nth(i)).not.toBeEmpty();
    }

    // Grouped under the assistant turn that used them.
    await expect(page.getByTestId("cited-message").first()).toBeVisible();
  });

  test("keeps the first answer's sources when a second answer arrives", async ({
    page,
  }) => {
    // The snapshot at the start of a later turn replaces the messages a client
    // assembled. If the rebuild dropped metadata, turn one's sources would
    // vanish the moment turn two started.
    await page.goto("/aws-strands/feature/agentic_chat_citations");
    await openChat(page);

    await sendChatMessage(page, "What is HTTP/3? Search the web.");
    await awaitLLMResponseDone(page);
    await expect(page.getByTestId("citation-item").first()).toBeVisible({
      timeout: 30000,
    });
    const firstTurnSources = await page.getByTestId("citation-item").count();
    expect(firstTurnSources).toBeGreaterThan(0);

    await sendChatMessage(page, "And what is QUIC? Search the web.");
    await awaitLLMResponseDone(page);

    // Two cited turns, and the first one's sources are still rendered.
    await expect(page.getByTestId("cited-message")).toHaveCount(2, {
      timeout: 30000,
    });
    const afterSecondTurn = await page.getByTestId("citation-item").count();
    expect(afterSecondTurn).toBeGreaterThanOrEqual(firstTurnSources);
  });
});
