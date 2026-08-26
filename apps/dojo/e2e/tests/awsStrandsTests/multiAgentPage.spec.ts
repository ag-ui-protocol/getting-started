import { test, expect } from "../../test-isolation-helper";
import { MultiAgentPage } from "../../featurePages/MultiAgentPage";

const NODES = ["researcher", "analyst", "writer"];

test("[Strands] Multi-Agent runs every graph node and reports the handoff route", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/multi_agent");

  const demo = new MultiAgentPage(page);
  await demo.waitForChatReady();

  await expect(demo.pipeline).toBeVisible();
  await demo.assertAllNodesPending(NODES);

  await demo.sendMessage("Research the benefits of remote work");
  await demo.assertUserMessageVisible("Research the benefits of remote work");

  // Each node reaches `done` only via its own STEP_FINISHED, and `done` is
  // distinct from `failed`, so this asserts the adapter drove the whole graph
  // to completion rather than merely streaming text.
  await expect
    .poll(() => demo.nodeStatuses(NODES))
    .toEqual(["done", "done", "done"]);

  // Handoffs are ordered, so this pins the route control took through the
  // graph, not merely that some handoff happened.
  await expect
    .poll(() => demo.handoffRoute())
    .toEqual(["researcher>analyst", "analyst>writer"]);

  // A completed run reports no failure and no cancel or interrupt notice.
  await expect(page.getByTestId("multi-agent-run-error")).toHaveCount(0);
  await expect(page.getByTestId("multi-agent-notice")).toHaveCount(0);
});

test("[Strands] Multi-Agent gives each node its own message in pipeline order", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/multi_agent");

  const demo = new MultiAgentPage(page);
  await demo.waitForChatReady();

  await demo.sendMessage("Research the benefits of remote work");

  // Each node's text lands in its own assistant message, and the three appear
  // in pipeline order rather than merged into one envelope.
  await expect
    .poll(() =>
      demo.assistantMessageOrder([/Research:/, /Analysis:/, /Summary:/]),
    )
    .toEqual([0, 1, 2]);
});

test("[Strands] Multi-Agent isolates each run from the previous one", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/multi_agent");

  const demo = new MultiAgentPage(page);
  await demo.waitForChatReady();

  await demo.sendMessage("Research the benefits of remote work");
  await expect
    .poll(() => demo.nodeStatuses(NODES))
    .toEqual(["done", "done", "done"]);

  // A second run resets the pipeline and produces its own handoff route
  // rather than appending to the first. The graph is rebuilt per run, so a
  // previous run's state cannot carry into this one.
  await demo.sendMessage("Research the benefits of remote work");

  await expect
    .poll(() => demo.handoffRoute())
    .toEqual(["researcher>analyst", "analyst>writer"]);
  await expect
    .poll(() => demo.nodeStatuses(NODES))
    .toEqual(["done", "done", "done"]);
});
