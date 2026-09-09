import { test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test("[ADK JavaScript] streams a recipe into shared state", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/shared_state");

  const sharedState = new SharedStatePage(page);
  await sharedState.openChat();
  await sharedState.sendMessage(
    "Please make a simple pasta recipe with Pasta as an ingredient.",
  );
  await sharedState.loader();
  await sharedState.awaitIngredientCard("Pasta");
  await sharedState.getInstructionItems(sharedState.instructionsContainer);
});
