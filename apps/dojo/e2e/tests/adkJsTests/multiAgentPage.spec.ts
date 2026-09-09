import { test, expect } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { MultiAgentPage } from "../../featurePages/MultiAgentPage";

const NODES = ["researcher", "analyst", "writer"];

test("[ADK JavaScript] Multi-Agent runs every graph node and reports the handoff route", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/multi_agent");

  const demo = new MultiAgentPage(page);
  await demo.waitForChatReady();

  await expect(demo.pipeline).toBeVisible();
  await demo.assertAllNodesPending(NODES);

  await demo.sendMessage("Research the benefits of remote work");
  await demo.assertUserMessageVisible("Research the benefits of remote work");

  await expect
    .poll(() => demo.nodeStatuses(NODES))
    .toEqual(["done", "done", "done"]);

  await expect
    .poll(() => demo.handoffRoute())
    .toEqual(["researcher>analyst", "analyst>writer"]);

  await expect(page.getByTestId("multi-agent-run-error")).toHaveCount(0);
  await expect(page.getByTestId("multi-agent-notice")).toHaveCount(0);
});

test("[ADK JavaScript] Multi-Agent gives each node its own message in pipeline order", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/multi_agent");

  const demo = new MultiAgentPage(page);
  await demo.waitForChatReady();

  await demo.sendMessage("Research the benefits of remote work");

  await expect
    .poll(() =>
      demo.assistantMessageOrder([/Research:/, /Analysis:/, /Summary:/]),
    )
    .toEqual([0, 1, 2]);
});

test("[ADK JavaScript] Multi-Agent isolates each run from the previous one", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, "/adk-js/feature/multi_agent");

  const demo = new MultiAgentPage(page);
  await demo.waitForChatReady();

  await demo.sendMessage("Research the benefits of remote work");
  await expect
    .poll(() => demo.nodeStatuses(NODES))
    .toEqual(["done", "done", "done"]);

  await demo.sendMessage("Research the benefits of remote work");

  await expect
    .poll(() => demo.handoffRoute())
    .toEqual(["researcher>analyst", "analyst>writer"]);
  await expect
    .poll(() => demo.nodeStatuses(NODES))
    .toEqual(["done", "done", "done"]);
});
