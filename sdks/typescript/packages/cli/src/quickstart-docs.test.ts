import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("points CopilotKit users to the generated app's root route", () => {
  const guide = readFileSync(
    new URL("../../../../../docs/quickstart/applications.mdx", import.meta.url),
    "utf8",
  );

  expect(guide).toContain("[http://localhost:3000](http://localhost:3000)");
  expect(guide).not.toContain("localhost:3000/copilotkit");
});
