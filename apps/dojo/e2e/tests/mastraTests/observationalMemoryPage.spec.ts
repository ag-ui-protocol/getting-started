import { test } from "../../test-isolation-helper";
import { ObservationalMemoryPage } from "../../featurePages/ObservationalMemoryPage";

const pageURL = "/mastra/feature/observational_memory";

test("[Mastra] observational memory surfaces as a distinct activity card", async ({
  page,
}) => {
  await page.goto(pageURL);

  const om = new ObservationalMemoryPage(page);

  await om.driveUntilObservation();
  await om.expectObservationActivityCard();
});
