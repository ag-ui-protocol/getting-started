import { test } from "../../test-isolation-helper";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";

test("[AG-UI .NET SDK] V1 Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await page.goto("/ag-ui-dotnet/feature/v1_agentic_chat");

  const chat = new V1AgenticChatPage(page);
  await chat.sendMessage("Hi");

  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello|Hi|hey|help|assist/i);
});
