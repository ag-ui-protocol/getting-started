import { test } from "../../event-trace-test";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";
import { v1AgenticChatPageEventTrace } from "./v1AgenticChatPage.event-trace";

test("[V1] LangGraph Python sends and receives a message", async ({
  page,
  eventTrace,
}) => {
  await page.goto("/langgraph/feature/v1_agentic_chat");

  const chat = new V1AgenticChatPage(page);
  await chat.sendMessage("Hi");

  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello|Hi|hey|help|assist/i);
  await eventTrace.expectJourney(
    v1AgenticChatPageEventTrace.langgraphPythonSendsAndReceivesAMessage,
  );
});
