import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect } from "../../event-trace-test";
import { AgenticGenUIPage } from "../../pages/langGraphFastAPIPages/AgenticUIGenPage";
import { agenticGenUIEventTrace } from "./agenticGenUI.event-trace";

test.describe("Agent Generative UI Feature", () => {
  test("[LangGraph FastAPI] should interact with the chat to get a planner on prompt", async ({
    page,
    eventTrace,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto("/langgraph-fastapi/feature/agentic_generative_ui");

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Give me a plan to make brownies");

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();

    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
    await eventTrace.expectJourney(
      agenticGenUIEventTrace.interactWithTheChatToGetAPlannerOnPrompt,
    );
  });

  test("[LangGraph FastAPI] should interact with the chat using predefined prompts and perform steps", async ({
    page,
    eventTrace,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto("/langgraph-fastapi/feature/agentic_generative_ui");

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Go to Mars");

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
    await eventTrace.expectJourney(
      agenticGenUIEventTrace.interactWithTheChatUsingPredefinedPromptsAndPerformSteps,
    );
  });
});
