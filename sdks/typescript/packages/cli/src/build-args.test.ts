import { expect, test } from "vitest";
import { buildCopilotKitCreateArgs } from "./build-args";

test("uses copilotkit@latest and forwards name + --no-banner", () => {
  const args = buildCopilotKitCreateArgs({ langgraphPy: true }, "my-app");
  expect(args).toEqual([
    "copilotkit@latest",
    "create",
    "--no-banner",
    "-n",
    "my-app",
    "-f",
    "langgraph-py",
  ]);
});

test("maps --crewai-flows (crewaiFlows) to -f flows", () => {
  const args = buildCopilotKitCreateArgs({ crewaiFlows: true }, "demo");
  expect(args).toContain("-f");
  expect(args).toContain("flows");
});

test("emits no -f when no framework flag is set", () => {
  const args = buildCopilotKitCreateArgs({}, "demo");
  expect(args).not.toContain("-f");
  expect(args).toEqual(["copilotkit@latest", "create", "--no-banner", "-n", "demo"]);
});

test("maps each framework flag to its canonical -f value", () => {
  const cases: Array<[Record<string, boolean>, string]> = [
    [{ langgraphJs: true }, "langgraph-js"],
    [{ mastra: true }, "mastra"],
    [{ ag2: true }, "ag2"],
    [{ llamaindex: true }, "llamaindex"],
    [{ agno: true }, "agno"],
    [{ pydanticAi: true }, "pydantic-ai"],
    [{ adk: true }, "adk"],
  ];
  for (const [opts, expected] of cases) {
    const args = buildCopilotKitCreateArgs(opts, "x");
    expect(args.slice(-2)).toEqual(["-f", expected]);
  }
});
