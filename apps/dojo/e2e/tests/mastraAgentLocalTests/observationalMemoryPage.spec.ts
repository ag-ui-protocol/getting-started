import { test } from "../../test-isolation-helper";
import { ObservationalMemoryPage } from "../../featurePages/ObservationalMemoryPage";

const pageURL = "/mastra-agent-local/feature/observational_memory";

test("[Mastra Agent Local] observational memory surfaces as a distinct activity card", async ({
  page,
}) => {
  await page.goto(pageURL);

  const om = new ObservationalMemoryPage(page);

  await om.driveUntilObservation();
  await om.expectObservationActivityCard();
});
